import { createRequire } from "node:module";

export const nodeTestFiles = [
  "**/*.{test,spec}.{ts,tsx,mts,cts}",
  "**/{test,tests,__tests__}/**/*.{ts,tsx,mts,cts}",
];

const imports = new Set(["test", "describe", "it", "suite"]);
const subtestMethods = new Set(["test"]);
const modifiers = new Set(["skip", "only", "todo"]);
export const nodeTestSafeCalls = [
  { from: "package", package: "node:test", name: [...imports, ...modifiers] },
];

// Accept each package's locked TypeScript without a root dependency. Inspect
// the resolved callee type, just as no-floating-promises' safe-call allowance
// does. Type construction syntax never decides whether a call is checked.
export default function createNodeTestPlugin(ts, configUrl) {
  // Use the exact matchers owned by the installed no-floating-promises rule.
  // Resolve through its dependency tree so no new package is required.
  const packageRequire = createRequire(configUrl);
  const tseslintRequire = createRequire(
    packageRequire.resolve("typescript-eslint"),
  );
  const pluginRequire = createRequire(
    tseslintRequire.resolve("@typescript-eslint/eslint-plugin"),
  );
  const { typeMatchesSomeSpecifier, valueMatchesSomeSpecifier } = pluginRequire(
    "@typescript-eslint/type-utils",
  );
  function isRegistration(declaration) {
    const registration =
      ts.isFunctionDeclaration(declaration) &&
      (imports.has(declaration.name?.text) ||
        modifiers.has(declaration.name?.text));
    const subtest =
      ts.isPropertySignature(declaration) &&
      declaration.name.getText() === "test" &&
      ts.isInterfaceDeclaration(declaration.parent) &&
      declaration.parent.name.text === "TestContext";
    if (!registration && !subtest) return false;
    for (let parent = declaration.parent; parent; parent = parent.parent) {
      if (ts.isModuleDeclaration(parent) && parent.name.text === "node:test")
        return true;
    }
    return false;
  }

  return {
    rules: {
      "direct-calls": {
        meta: {
          type: "problem",
          docs: {
            description:
              "Confine node:test callable types to direct imported registrations and handled context subtests.",
            requiresTypeChecking: true,
          },
          schema: [],
          messages: {
            direct:
              "Call node:test only on an imported test, describe, it or suite binding (or its .skip, .only or .todo), or directly on an enclosing test callback's context.test method.",
            handled:
              "Await or return the direct context.test call, including when joining subtests with Promise.all or Promise.allSettled.",
          },
        },
        create(context) {
          const services = context.sourceCode.parserServices;
          const checker = services.program.getTypeChecker();
          const typed = (node) => services.esTreeNodeToTSNodeMap.get(node);
          const symbolAt = (node) => checker.getSymbolAtLocation(typed(node));
          function matchesSymbol(symbol) {
            if (symbol?.flags & ts.SymbolFlags.Alias)
              symbol = checker.getAliasedSymbol(symbol);
            return symbol?.getDeclarations()?.some(isRegistration) ?? false;
          }
          function registrationType(type, seen = new Set()) {
            if (!type || seen.has(type)) return false;
            seen.add(type);
            if (
              matchesSymbol(type.getSymbol()) ||
              matchesSymbol(type.aliasSymbol)
            )
              return true;
            // Preserve provenance through unions, intersections and constrained
            // generics, including instantiated signatures and mapped types.
            if (
              type.isUnionOrIntersection() &&
              type.types.some((part) => registrationType(part, seen))
            )
              return true;
            if (
              type.getCallSignatures().some((signature) => {
                const declaration = signature.getDeclaration();
                return declaration && isRegistration(declaration);
              })
            )
              return true;
            return registrationType(
              checker.getBaseConstraintOfType(type),
              seen,
            );
          }
          function isRegistrationCall(node) {
            const type = checker.getTypeAtLocation(typed(node.callee));
            if (registrationType(type)) return true;
            // The allowance also matches values by local name. A HookFn called
            // "test", for example, can otherwise hide a rejected promise.
            const exempt =
              valueMatchesSomeSpecifier(
                node.callee,
                nodeTestSafeCalls,
                services.program,
                type,
              ) ||
              typeMatchesSomeSpecifier(
                type,
                nodeTestSafeCalls,
                services.program,
              );
            // Synchronous context.skip/context.todo controls return void. The
            // promise rule already accepts void calls without an allowance.
            return (
              exempt &&
              !(
                checker.getTypeAtLocation(typed(node)).flags & ts.TypeFlags.Void
              )
            );
          }

          function imported(node) {
            if (node.type !== "Identifier") return false;
            return (
              symbolAt(node)
                ?.getDeclarations()
                ?.some((declaration) => {
                  if (ts.isImportClause(declaration)) {
                    return (
                      !declaration.isTypeOnly &&
                      declaration.parent.moduleSpecifier.text === "node:test"
                    );
                  }
                  if (
                    !ts.isImportSpecifier(declaration) ||
                    declaration.isTypeOnly
                  )
                    return false;
                  const clause = declaration.parent.parent;
                  return (
                    !clause.isTypeOnly &&
                    clause.parent.moduleSpecifier.text === "node:test" &&
                    imports.has(
                      (declaration.propertyName ?? declaration.name).text,
                    )
                  );
                }) ?? false
            );
          }
          const member = (node, names) =>
            node.type === "MemberExpression" &&
            !node.computed &&
            !node.optional &&
            node.property.type === "Identifier" &&
            names.has(node.property.name);

          function callbackContext(node) {
            if (node.type !== "Identifier") return false;
            const symbol = symbolAt(node);
            if (!symbol) return false;
            for (let parent = node.parent; parent; parent = parent.parent) {
              if (
                (parent.type === "ArrowFunctionExpression" ||
                  parent.type === "FunctionExpression") &&
                parent.params[0]?.type === "Identifier" &&
                symbolAt(parent.params[0]) === symbol
              ) {
                const call = parent.parent;
                return (
                  call.type === "CallExpression" &&
                  call.arguments.at(-1) === parent &&
                  isRegistrationCall(call) &&
                  callKind(call) !== undefined
                );
              }
            }
            return false;
          }
          function callKind(call) {
            if (call.optional) return undefined;
            let callee = call.callee;
            if (member(callee, modifiers)) callee = callee.object;
            if (imported(callee)) return "registration";
            if (
              member(callee, subtestMethods) &&
              callbackContext(callee.object)
            )
              return "subtest";
            return undefined;
          }
          function handled(node) {
            if (node.parent?.type === "ChainExpression") node = node.parent;
            const parent = node.parent;
            if (
              (parent.type === "AwaitExpression" && parent.argument === node) ||
              (parent.type === "ReturnStatement" && parent.argument === node) ||
              (parent.type === "ArrowFunctionExpression" &&
                parent.body === node)
            )
              return true;
            // Concurrent children must be joined by the actual built-in all or
            // allSettled, with that join awaited or returned. race/any can end
            // before a child. A helper borrowing PromiseConstructor is unsafe.
            if (parent.type !== "ArrayExpression") return false;
            const call = parent.parent;
            if (
              call.type !== "CallExpression" ||
              call.arguments[0] !== parent ||
              call.callee.type !== "MemberExpression" ||
              call.callee.object.type !== "Identifier"
            )
              return false;
            const builtin = (declaration) =>
              services.program.isSourceFileDefaultLibrary(
                declaration.getSourceFile(),
              );
            if (!symbolAt(call.callee.object)?.getDeclarations()?.some(builtin))
              return false;
            const symbol = symbolAt(call.callee);
            return (
              ["all", "allSettled"].includes(symbol?.name) &&
              symbol
                .getDeclarations()
                ?.some(
                  (declaration) =>
                    ts.isInterfaceDeclaration(declaration.parent) &&
                    declaration.parent.name.text === "PromiseConstructor" &&
                    builtin(declaration),
                ) &&
              handled(call)
            );
          }
          return {
            CallExpression(node) {
              if (!isRegistrationCall(node)) return;
              const kind = callKind(node);
              if (!kind) context.report({ node, messageId: "direct" });
              else if (kind === "subtest" && !handled(node))
                context.report({ node, messageId: "handled" });
            },
          };
        },
      },
    },
  };
}

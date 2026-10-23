export const nodeTestFiles = [
  "**/*.{test,spec}.{ts,tsx,mts,cts}",
  "**/{test,tests,__tests__}/**/*.{ts,tsx,mts,cts}",
];

// Accept each package's locked TypeScript so the shared plugin needs no
// root-level dependency installation. Match symbols, never callable types.
export default function createNodeTestPlugin(ts) {
  function inNodeTest(declaration) {
    for (let parent = declaration.parent; parent; parent = parent.parent) {
      if (ts.isModuleDeclaration(parent) && parent.name.text === "node:test")
        return true;
    }
    return false;
  }

  const registrationNames = new Set([
    "test",
    "describe",
    "it",
    "suite",
    "skip",
    "only",
    "todo",
  ]);
  const isRegistration = (declaration) =>
    ts.isFunctionDeclaration(declaration) &&
    registrationNames.has(declaration.name?.text) &&
    inNodeTest(declaration);
  const isSubtest = (declaration) =>
    ts.isPropertySignature(declaration) &&
    declaration.name.getText() === "test" &&
    ts.isInterfaceDeclaration(declaration.parent) &&
    declaration.parent.name.text === "TestContext" &&
    inNodeTest(declaration);

  function rule(matches, message, subtests = false) {
    return {
      meta: {
        type: "problem",
        docs: { description: message },
        schema: [],
        messages: { direct: message },
      },
      create(context) {
        const services = context.sourceCode.parserServices;
        const checker = services.program.getTypeChecker();
        const references = new Set(
          context.sourceCode.scopeManager.scopes.flatMap((scope) =>
            scope.references.map((reference) => reference.identifier),
          ),
        );
        function matchesSymbol(symbol) {
          if (symbol?.flags & ts.SymbolFlags.Alias)
            symbol = checker.getAliasedSymbol(symbol);
          return symbol?.getDeclarations()?.some(matches) ?? false;
        }
        function symbols(node) {
          const typed = services.esTreeNodeToTSNodeMap.get(node);
          if (
            ts.isElementAccessExpression(typed) ||
            ts.isIndexedAccessTypeNode(typed)
          ) {
            const key = checker.getTypeAtLocation(
              ts.isElementAccessExpression(typed)
                ? typed.argumentExpression
                : typed.indexType,
            );
            const object = ts.isElementAccessExpression(typed)
              ? typed.expression
              : typed.objectType;
            return (key.isUnion() ? key.types : [key])
              .filter((part) => part.isStringLiteral())
              .map((part) =>
                checker.getTypeAtLocation(object).getProperty(part.value),
              );
          }
          return [checker.getSymbolAtLocation(typed)];
        }
        const matched = (node) => symbols(node).some(matchesSymbol);
        function extractedProperties(node) {
          const typed = services.esTreeNodeToTSNodeMap.get(node);
          const type = checker.getTypeAtLocation(
            node.parent.type === "AssignmentExpression"
              ? services.esTreeNodeToTSNodeMap.get(node.parent.right)
              : typed,
          );
          return node.properties.filter((property) => {
            if (property.type !== "Property") return false;
            const key = property.computed
              ? checker.getTypeAtLocation(
                  services.esTreeNodeToTSNodeMap.get(property.key),
                )
              : undefined;
            const names = property.computed
              ? (key.isUnion() ? key.types : [key])
                  .filter((part) => part.isStringLiteral())
                  .map((part) => part.value)
              : [property.key.name ?? property.key.value];
            return names.some(
              (name) => name && matchesSymbol(type.getProperty(name)),
            );
          });
        }
        function unchain(node) {
          return node.parent?.type === "ChainExpression" ? node.parent : node;
        }
        function handled(node) {
          node = unchain(node);
          const parent = node.parent;
          if (
            (parent.type === "AwaitExpression" && parent.argument === node) ||
            (parent.type === "ReturnStatement" && parent.argument === node) ||
            (parent.type === "ArrowFunctionExpression" && parent.body === node)
          )
            return true;
          // Preserve concurrent subtests when the built-in join is itself
          // awaited or returned. race/any can finish before a child does.
          if (parent.type === "ArrayExpression") {
            const call = parent.parent;
            if (
              call.type === "CallExpression" &&
              call.arguments[0] === parent &&
              call.callee.type === "MemberExpression" &&
              call.callee.object.type === "Identifier" &&
              symbols(call.callee.object)[0]
                ?.getDeclarations()
                ?.some((declaration) =>
                  services.program.isSourceFileDefaultLibrary(
                    declaration.getSourceFile(),
                  ),
                )
            ) {
              const symbol = symbols(call.callee)[0];
              if (
                ["all", "allSettled"].includes(symbol?.name) &&
                symbol
                  .getDeclarations()
                  ?.some(
                    (declaration) =>
                      ts.isInterfaceDeclaration(declaration.parent) &&
                      declaration.parent.name.text === "PromiseConstructor" &&
                      services.program.isSourceFileDefaultLibrary(
                        declaration.getSourceFile(),
                      ),
                  )
              )
                return handled(call);
            }
          }
          return false;
        }
        function inspect(node) {
          if (!matched(node)) return;
          const parent = node.parent;
          if (parent.type === "TSImportType") return;
          // Inspect the outermost registration member once, including in
          // typeof queries. Its binding must remain a direct call target.
          if (
            !subtests &&
            ((parent.type === "MemberExpression" && parent.object === node) ||
              (parent.type === "TSQualifiedName" && parent.left === node)) &&
            symbols(parent).some((symbol) => {
              if (symbol?.flags & ts.SymbolFlags.Alias)
                symbol = checker.getAliasedSymbol(symbol);
              return symbol?.getDeclarations()?.some(inNodeTest);
            })
          )
            return;
          if (
            !subtests &&
            parent.type === "VariableDeclarator" &&
            parent.init === node &&
            parent.id.type === "ObjectPattern" &&
            extractedProperties(parent.id).length
          )
            return;
          if (
            parent.type === "CallExpression" &&
            parent.callee === node &&
            (!subtests || handled(parent))
          )
            return;
          context.report({ node, messageId: "direct" });
        }
        return {
          Identifier(node) {
            if (references.has(node)) inspect(node);
          },
          MemberExpression: inspect,
          TSQualifiedName: inspect,
          TSIndexedAccessType: inspect,
          // Destructuring names bind new symbols. Inspect the source property
          // on the pattern's contextual type, including callback parameters.
          ObjectPattern(node) {
            for (const property of extractedProperties(node))
              context.report({ node: property, messageId: "direct" });
          },
          TSImportType(node) {
            if (subtests) return;
            const typed = services.esTreeNodeToTSNodeMap.get(node);
            if (
              typed.isTypeOf &&
              ts.isLiteralTypeNode(typed.argument) &&
              typed.argument.literal.text === "node:test" &&
              (!typed.qualifier ||
                matchesSymbol(checker.getSymbolAtLocation(typed.qualifier)))
            )
              context.report({ node, messageId: "direct" });
          },
        };
      },
    };
  }
  return {
    rules: {
      "direct-registrations": rule(
        isRegistration,
        "Call node:test registrations directly on their imported bindings; value aliases and type references are forbidden.",
      ),
      "no-floating-subtests": rule(
        isSubtest,
        "Call the test context's test method directly and await or return its result; method extraction is forbidden.",
        true,
      ),
    },
  };
}

export const nodeTestFiles = [
  "**/*.{test,spec}.{ts,tsx,mts,cts}",
  "**/{test,tests,__tests__}/**/*.{ts,tsx,mts,cts}",
];

// Accept each package's locked dependencies so the shared plugin needs no
// root-level TypeScript or ESLint installation.
export default function createNodeTestPlugin(ts, tsPlugin) {
  const floatingPromises = tsPlugin.rules["no-floating-promises"];

  // Node types TestContext.test as typeof test, so the package registration
  // allowance also matches subtests. Check their declaration and reuse the
  // upstream promise rule with its default, empty safe-call allowance.
  const noFloatingSubtests = {
    ...floatingPromises,
    meta: {
      ...floatingPromises.meta,
      docs: { description: "Require handling node:test subtest promises" },
      schema: [],
    },
    create(context) {
      const upstream = floatingPromises.create(context);
      const services = context.sourceCode.parserServices;
      const checker = services.program.getTypeChecker();

      function isSubtestSymbol(symbol, seen = new Set()) {
        if (!symbol || seen.has(symbol)) return false;
        seen.add(symbol);
        return (symbol.getDeclarations() ?? []).some((declaration) => {
          if (
            ts.isPropertySignature(declaration) &&
            declaration.name.getText() === "test" &&
            ts.isInterfaceDeclaration(declaration.parent) &&
            declaration.parent.name.text === "TestContext"
          ) {
            for (
              let parent = declaration.parent.parent;
              parent;
              parent = parent.parent
            ) {
              if (
                ts.isModuleDeclaration(parent) &&
                parent.name.text === "node:test"
              )
                return true;
            }
          }
          if (
            ts.isVariableDeclaration(declaration) &&
            declaration.initializer
          ) {
            return isSubtest(declaration.initializer, seen);
          }
          if (ts.isBindingElement(declaration)) {
            const variable = declaration.parent.parent;
            if (ts.isVariableDeclaration(variable) && variable.initializer) {
              const name = declaration.propertyName ?? declaration.name;
              if (!(ts.isIdentifier(name) || ts.isStringLiteralLike(name)))
                return false;
              const property = checker
                .getTypeAtLocation(variable.initializer)
                .getProperty(name.text);
              return isSubtestSymbol(property, seen);
            }
          }
          return false;
        });
      }

      function isSubtest(node, seen = new Set()) {
        if (ts.isParenthesizedExpression(node))
          return isSubtest(node.expression, seen);
        if (ts.isElementAccessExpression(node)) {
          const key = checker.getTypeAtLocation(node.argumentExpression);
          if (key.isStringLiteral()) {
            return isSubtestSymbol(
              checker.getTypeAtLocation(node.expression).getProperty(key.value),
              seen,
            );
          }
        }
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "bind"
        ) {
          return isSubtest(node.expression.expression, seen);
        }
        return isSubtestSymbol(checker.getSymbolAtLocation(node), seen);
      }

      return {
        ExpressionStatement(node) {
          const expression =
            node.expression.type === "ChainExpression"
              ? node.expression.expression
              : node.expression;
          if (
            expression.type === "CallExpression" &&
            isSubtest(services.esTreeNodeToTSNodeMap.get(expression.callee))
          ) {
            upstream.ExpressionStatement(node);
          }
        },
      };
    },
  };

  return { rules: { "no-floating-subtests": noFloatingSubtests } };
}

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const methods = new Set(['get', 'post', 'put', 'patch', 'delete']);
const parse = file => ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
const literal = node => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
function walk(node, visit) { visit(node); ts.forEachChild(node, child => walk(child, visit)); }
function routeManifest() {
  const index = parse(path.join(root, 'src/routes/index.ts'));
  const imports = {};
  for (const node of index.statements) {
    if (!ts.isImportDeclaration(node) || !node.importClause || !node.moduleSpecifier.text.startsWith('./')) continue;
    const file = path.join(root, 'src/routes', `${node.moduleSpecifier.text.slice(2)}.ts`);
    if (node.importClause.name) imports[node.importClause.name.text] = file;
    for (const binding of node.importClause.namedBindings?.elements || []) imports[binding.name.text] = file;
  }
  const routes = [];
  walk(index, node => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== 'use') return;
    const prefix = literal(node.arguments[0]);
    const file = imports[node.arguments[1]?.getText(index)];
    if (prefix === null || !file) return;
    const source = parse(file);
    walk(source, route => {
      if (!ts.isCallExpression(route) || !ts.isPropertyAccessExpression(route.expression) || !methods.has(route.expression.name.text)) return;
      const suffix = literal(route.arguments[0]);
      if (suffix === null) return;
      routes.push({ method: route.expression.name.text.toUpperCase(), path: `/api/${prefix}/${suffix}`.replace(/\/{2,}/g, '/').replace(/\/$/, ''), file: path.relative(root, file), line: source.getLineAndCharacterOfPosition(route.getStart()).line + 1 });
    });
  });
  return routes;
}
module.exports = { routeManifest };
if (require.main === module) process.stdout.write(JSON.stringify(routeManifest(), null, 2) + '\n');

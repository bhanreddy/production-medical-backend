const fs = require('fs');
const path = require('path');

const dir = '/Users/bhanureddy/Desktop/medical/Medical POS Backend/src/routes';
const files = fs.readdirSync(dir);

const routes = [];

files.forEach(file => {
  if (!file.endsWith('.ts')) return;
  const content = fs.readFileSync(path.join(dir, file), 'utf-8');
  
  // also find the router name if possible
  const lines = content.split('\n');
  lines.forEach(line => {
    const match = line.match(/\.(get|post|put|patch|delete)\(['"]([^'"]+)['"]/);
    if (match) {
        const [, method, endpointPath] = match;
        const prefix = file.replace('.ts', '');
        if (prefix !== 'index') {
            routes.push(`${file.padEnd(20)} | ${method.toUpperCase().padEnd(6)} | /api/${prefix}${endpointPath.replace(/\/$/, '')}`);
        }
    }
  });
});

fs.writeFileSync('/Users/bhanureddy/Desktop/medical/Medical POS Backend/routes_manifest.txt', routes.join('\n'));
console.log('Routes extracted successfully to routes_manifest.txt');

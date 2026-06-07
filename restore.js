const fs = require('fs');
const data = JSON.parse(fs.readFileSync('/Users/bhanureddy/.gemini/antigravity-ide/brain/c26a6093-b0d3-4a1d-a35f-65a2c570a92c/scratch/step253.json', 'utf8'));
const content = data.content;
const lines = content.split('\n');
let codeLines = [];
let parsingCode = false;
for (const line of lines) {
  if (line.match(/^1: /)) {
    parsingCode = true;
  }
  if (parsingCode && line.startsWith('The above content shows')) {
    break;
  }
  if (parsingCode) {
    codeLines.push(line.replace(/^\d+:\s/, ''));
  }
}
fs.writeFileSync('/Users/bhanureddy/Desktop/Single Source of Truth/medical/backend/src/routes/inventory.ts', codeLines.join('\n'));
console.log('Restored inventory.ts successfully.');

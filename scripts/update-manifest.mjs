import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const file=path.join(root,'manifest.json');
const manifest=JSON.parse(fs.readFileSync(file,'utf8'));
for(const entry of manifest.files){
  if(path.basename(entry.name)!==entry.name)throw Error('Invalid payload filename');
  entry.sha256=createHash('sha256').update(fs.readFileSync(path.join(root,'payload',entry.name))).digest('hex');
}
fs.writeFileSync(file,JSON.stringify(manifest,null,2)+'\n');
console.log(`Updated ${manifest.files.length} payload hashes.`);

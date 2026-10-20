import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {checkPayload} from '../installer.mjs';

if(process.platform!=='win32')throw Error('Build the Windows installer ZIP on Windows.');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const manifest=checkPayload(root);
const names=['설치.cmd','installer.mjs','manifest.json','먼저 읽기.txt'];
const payload=fs.readdirSync(path.join(root,'payload')).sort();
if(JSON.stringify(payload)!==JSON.stringify(manifest.files.map(f=>f.name).sort()))throw Error('Unexpected files in payload; refusing to package.');
const dist=path.join(root,'dist');fs.mkdirSync(dist,{recursive:true});
const output=path.join(dist,`Codex-Model-Guard-Windows-v${manifest.version}.zip`);
const entries=[...names.map(name=>({name,path:path.join(root,name)})),
  ...manifest.files.map(file=>({name:'payload/'+file.name,path:path.join(root,'payload',file.name)}))];
const command=`$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$taskStream = [IO.File]::Open($env:MODEL_GUARD_BUILD_ZIP, [IO.FileMode]::Create)
try {
  $taskZip = [IO.Compression.ZipArchive]::new($taskStream, [IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($taskEntry in (ConvertFrom-Json $env:MODEL_GUARD_BUILD_FILES)) {
      [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($taskZip, $taskEntry.path, $taskEntry.name, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
  } finally { $taskZip.Dispose() }
} finally { $taskStream.Dispose() }`;
const result=spawnSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',command],{
  windowsHide:true,stdio:'inherit',env:{...process.env,
    MODEL_GUARD_BUILD_FILES:JSON.stringify(entries),
    MODEL_GUARD_BUILD_ZIP:output}
});
if(result.error)throw result.error;
if(result.status!==0)throw Error('ZIP build failed.');
console.log(output);

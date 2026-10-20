import { submitBackground } from './background-submit.mjs';

let text = '';
for await (const chunk of process.stdin) {
  text += chunk;
  if (Buffer.byteLength(text) > 4 * 1024 * 1024) process.exit(1);
}
try {
  const result = await submitBackground(JSON.parse(text), {
    ready:() => { if (process.connected) process.send({ready:true}); }
  });
  if (process.connected) process.disconnect();
  process.exitCode = result.submitted ? 0 : 1;
} catch {
  if (process.connected) { process.send({ready:false}); process.disconnect(); }
  process.exitCode = 1;
}

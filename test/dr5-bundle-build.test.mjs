import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
test('standalone Audition Room inlines current and historical renderers with valid JavaScript',()=>{
 execFileSync(process.execPath,['app/build.mjs'],{stdio:'pipe'});
 const html=fs.readFileSync('dist/audition-room.html','utf8');
 const script=html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
 assert.ok(script);assert.ok(script.includes('history/pre-dr5/src/kit/band.js'));
 assert.doesNotThrow(()=>new vm.Script(script)); // Compile only; never execute browser/audio code.
});

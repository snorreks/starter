import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { Compile } from 'typebox/compile';
import * as v from 'valibot';
import * as z from 'zod';
import * as zm from 'zod/mini';
import { gzipSync } from 'node:zlib';

const tb = Type.Object({ title: Type.String({minLength:1,maxLength:120}), body: Type.String({maxLength:4000}) }, {additionalProperties:false});
const vb = v.strictObject({title:v.pipe(v.string(),v.minLength(1),v.maxLength(120)),body:v.pipe(v.string(),v.maxLength(4000))});
const zz = z.strictObject({title:z.string().min(1).max(120),body:z.string().max(4000)});
const mini = zm.strictObject({title:zm.string().check(zm.minLength(1),zm.maxLength(120)),body:zm.string().check(zm.maxLength(4000))});
const compiled=Compile(tb);
const checks = [
  ['typebox-value', (x:unknown)=>Value.Check(tb,x)],
  ['typebox-compiled', (x:unknown)=>compiled.Check(x)],
  ['valibot', (x:unknown)=>v.safeParse(vb,x).success],
  ['zod', (x:unknown)=>zz.safeParse(x).success],
  ['zod-mini', (x:unknown)=>zm.safeParse(mini,x).success],
] as const;
const cases=[{title:'hello',body:'body'},{title:'',body:''},{title:'hello',body:'',ownerId:'other'},{title:'hello',body:7}];
for(const [name,check] of checks) {
  const verdicts=cases.map(check);
  if(JSON.stringify(verdicts)!=='[true,false,false,false]') throw new Error(`semantic mismatch: ${name}`);
  const samples:number[]=[]; let accepted=0;
  for(let i=0;i<10000;i++) accepted+=Number(check(cases[i%cases.length]));
  for(let round=0;round<5;round++) { const start=performance.now(); for(let i=0;i<100000;i++) accepted+=Number(check(cases[i%cases.length])); samples.push((performance.now()-start)*1000/100000); }
  samples.sort((a,b)=>a-b);
  console.log(JSON.stringify({kind:'runtime',name,medianUsPerCheck:samples[2],accepted,jit: name==='typebox-compiled'?compiled.IsAccelerated():undefined}));
}
const entries:Record<string,string>={
  'typebox-value':`import {Type} from 'typebox'; import {Value} from 'typebox/value'; const S=Type.Object({title:Type.String({minLength:1,maxLength:120}),body:Type.String({maxLength:4000})},{additionalProperties:false}); export const check=(x)=>Value.Check(S,x);`,
  valibot:`import * as v from 'valibot'; const S=v.strictObject({title:v.pipe(v.string(),v.minLength(1),v.maxLength(120)),body:v.pipe(v.string(),v.maxLength(4000))}); export const check=(x)=>v.safeParse(S,x).success;`,
  zod:`import * as z from 'zod'; const S=z.strictObject({title:z.string().min(1).max(120),body:z.string().max(4000)}); export const check=(x)=>S.safeParse(x).success;`,
  'zod-mini':`import * as z from 'zod/mini'; const S=z.strictObject({title:z.string().check(z.minLength(1),z.maxLength(120)),body:z.string().check(z.maxLength(4000))}); export const check=(x)=>z.safeParse(S,x).success;`,
};
for(const [name,code] of Object.entries(entries)) {
  const path=`${import.meta.dir}/${name}.entry.ts`; await Bun.write(path,code);
  const build=await Bun.build({entrypoints:[path],target:'browser',minify:true});
  if(!build.success) throw new Error(`${name} build failed`);
  const bytes=new Uint8Array(await build.outputs[0].arrayBuffer());
  console.log(JSON.stringify({kind:'browser-bundle',name,minifiedBytes:bytes.length,gzipBytes:gzipSync(bytes).length}));
}
console.log(JSON.stringify({kind:'standard-schema',typebox:'~standard' in tb,valibot:'~standard' in vb,zod:'~standard' in zz,zodMini:'~standard' in mini}));

#!/usr/bin/env node
// Test adapter: the production SDKs still require an HTTPS origin by default.
import {spawn} from 'node:child_process';
let text='';for await(const chunk of process.stdin)text+=chunk;
const r=JSON.parse(text);r.allowHttpLoopback=true;
const child=spawn(process.execPath,[new URL('../cli/broker.mjs',import.meta.url).pathname],{stdio:['pipe','inherit','inherit']});
child.stdin.end(JSON.stringify(r));child.on('exit',code=>{process.exitCode=code??1;});

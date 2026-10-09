/*
|--------------------------------------------------------------------------
| JavaScript entrypoint for running ace commands
|--------------------------------------------------------------------------
|
| DO NOT MODIFY THIS FILE AS IT WILL BE OVERRIDDEN DURING THE BUILD
| PROCESS.
|
| Node cannot run the TypeScript sources directly, so this file registers
| the @poppinss/ts-exec hook before handing over to "bin/console.ts".
|
*/

import '@poppinss/ts-exec'

await import('./bin/console.js')

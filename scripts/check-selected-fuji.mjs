import {verifySelectedFuji} from './lib/verify-selected-fuji.mjs';
try {console.log(JSON.stringify(await verifySelectedFuji(),null,2));}
catch(error){console.error(/^FUJI_[A-Z_]+$/.test(error?.message)?error.message:'FUJI_VERIFICATION_FAILED');process.exitCode=1;}

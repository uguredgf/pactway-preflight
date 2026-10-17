// Explicit local model selection; existing private UID/catalog flow is unchanged.
import {LOCAL_MODEL} from './lib/local-model-setup.mjs';
import {FUJI_PROFILE} from '../src/audit/fuji-deployment-profile.mjs';
process.env.PACTWAY_LOCAL_MODEL=LOCAL_MODEL;
process.env.PACTWAY_FUJI_PROFILE=FUJI_PROFILE.id;
const {runReadonlyConnector}=await import('./connect-okx-tr-readonly.mjs');
await runReadonlyConnector();

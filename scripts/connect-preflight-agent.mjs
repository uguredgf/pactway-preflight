// The separate port preserves the user's existing read-only Preflight session.
import {LOCAL_MODEL} from './lib/local-model-setup.mjs';
import {FUJI_PROFILE} from '../src/audit/fuji-deployment-profile.mjs';

process.env.PACTWAY_LOCAL_MODEL=LOCAL_MODEL;
process.env.PACTWAY_FUJI_PROFILE=FUJI_PROFILE.id;
process.env.PACTWAY_APP_PORT='18783';
const {runReadonlyConnector}=await import('./connect-okx-tr-readonly.mjs');
await runReadonlyConnector();

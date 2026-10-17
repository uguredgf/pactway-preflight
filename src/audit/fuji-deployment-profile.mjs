// Public deployment chosen after RPC/source verification and user's independent
// Core C-Chain address confirmation. No private keys or transaction authority.
export const FUJI_PROFILE=Object.freeze({
  id:'fuji-core-2026-10-17',chainId:43113,buildProfile:'remix-unoptimized-crlf',
  contractAddress:'0xd2f8b2164c9843c2eb15dfed696d230427eb436b',
  transactionHash:'0x3db47037cc91e538d5489cd726bade798ad17f16607b0e0b2acac55b995ba215',
  owner:'0x7ca57c6b30eff24875c368d8116aa4c13d97f067',
  recorder:'0x7ca57c6b30eff24875c368d8116aa4c13d97f067',
  sourceSha256:'f3992bab3c58076bbdc65cddb0034c4356bded38732934a49b135115ee984df5'
});

export function fujiEnvironment(environment={}) {
  if(environment.PACTWAY_FUJI_PROFILE===undefined)return {};
  if(environment.PACTWAY_FUJI_PROFILE!==FUJI_PROFILE.id)throw new Error('FUJI_PROFILE_INVALID');
  return {MG_FUJI_PROFILE:FUJI_PROFILE.id};
}

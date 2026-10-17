export const FUJI_ACCEPTANCE_PROFILE=Object.freeze({
  id:'fixture-first-receipt-2026-10-17',mode:'fixture',
  publicationPath:'exports/fuji-publication-IDtXJk/publication.json',
  publicationSha256:'5707e0650af5da7850f839fb2b5cab836d20ed24063ab4e81190b9e40f35e758',
  localReceiptCount:7,publishedReceiptCount:1,sequence:'1',onlyFirstReceipt:true,
  taskId:'0x66b2ef33c3cb4e51a736d65895da4685bef92721cefdbcd54748919a6978885f',
  policyHash:'0xf2b025ad38c847042d1995db979643cfa3ffca98f656ec1699afc00f5c482d74',
  receiptHash:'0x65cecdd0b613637121e8358dacdf37e444b324250e2f19e7fca05ae5e60853b6',
  policy:Object.freeze({transactionHash:'0xb5fad2b9b143c705772e573a487006ac39131aef35704c16d020e54a147c5fd6',
    blockNumber:'0x38d4748',blockHash:'0x6e274c44e4c9465b0e173be0e81baf5525329df5f48443dcd5a7fc2436fd48b0'}),
  firstReceipt:Object.freeze({transactionHash:'0xee5c74fb2da7962600c99dea50e9d4f6e02201eb36ab96ef25db85e6dd8921df',
    blockNumber:'0x38d4764',blockHash:'0xca6e763c9fdc7e99734983547d04a6b2718a851e990648604bb95e380fadecd5'})
});

export const failedFujiAcceptance=reasonCode=>({state:'VERIFICATION_FAILED',mode:'fixture',onlyFirstReceipt:true,
  writeEnabled:false,...(reasonCode==='FUJI_RPC_RATE_LIMITED'?{reasonCode}: {})});

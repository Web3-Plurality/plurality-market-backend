// import { LitNodeClient } from "@lit-protocol/lit-node-client";
// import { LitNetwork } from "@lit-protocol/constants";
// // import { logStep, getOutputData } from "./utils/state-manager";
// import { ethers } from "ethers";
// import { LitContracts } from "@lit-protocol/contracts-sdk";
// import { AuthMethodScope, LIT_RPC } from "@lit-protocol/constants";
// import { LitPKPResource, LitActionResource } from "@lit-protocol/auth-helpers";
// import { LitAbility } from "@lit-protocol/types";
// // import { ipfsHelpers } from "ipfs-helpers";



// const LitTest = () => {

//     const EOA_PRIVATE_KEY =
//   "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

// const connectLitNodeClientToDatilDev = async (step: number) => {
//   const config = {
//     litNetwork: LitNetwork.DatilDev,
//     debug: true,
//   };

//   const client = new LitNodeClient(config);
//   await client.connect();
//   console.log("Connected to LitNodeClient");
//   return client;
// };


// const connectLitContractsToDatilDev = async (step: number) => {

  
//     const litContracts = new LitContracts({
//       signer: new ethers.Wallet(
//         EOA_PRIVATE_KEY,
//         new ethers.providers.JsonRpcProvider(LIT_RPC.CHRONICLE_YELLOWSTONE)
//       ),
//       debug: false,
//       network: LitNetwork.DatilDev,
//     });
  
//     await litContracts.connect();
  
//     console.log("Step 2 outputData:", litContracts);
//   };

//     return (
//         <div>
//         <h1>Testing Lit</h1>
//         </div>
//     );


// }

// export default LitTest;
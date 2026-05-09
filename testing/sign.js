const { ethers } = require('ethers');
const dotenv  = require('dotenv');
const {SiweMessage} = require('siwe');
dotenv.config();

// Replace with your own private key (DO NOT SHARE THIS KEY PUBLICLY)
const privateKey = process.env.PRIVATE_KEY;
const wallet = new ethers.Wallet(privateKey);

// The message you want to sign
const nonce = "0NeGxcsLBAI7cF3PH";
const address="0x843c97F8A229C7dF8667b6C0867f4c1732685707"
const statement="I am the owner of this address"
const domain = "localhost";
const origin = "https://localhost/login";
// Sign the message
async function signMessage() {
    try {
        // Sign the message
        const message = new SiweMessage({
            domain,
            address,
            statement,
            uri: origin,
            version: '1',
            chainId: '1',
            nonce: nonce
        });
            const msg = message.prepareMessage();

        const signature = await wallet.signMessage(msg);
        console.log('Message:\n',encodeURIComponent(msg));
        console.log('Signature:', signature);
        const siwe = {"siwe":signature,"message":msg}
        console.log("siwe",JSON.stringify(siwe));

        // // Verify the signature
        // const signerAddress = ethers.utils.verifyMessage(message, signature);
        // console.log('Signer Address:', signerAddress);

    } catch (error) {
        console.error('Error signing message:', error);
    }
}

signMessage();

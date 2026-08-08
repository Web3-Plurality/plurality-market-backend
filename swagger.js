const swaggerAutogen = require('swagger-autogen')({ openapi: '3.0.0' });
const dotenv = require('dotenv');
dotenv.config();

const swaggerConfig = {
  outputFile: './src/swagger.json',
  endpointsFiles: ['./src/index.ts'],
  doc: {
    info: {
      title: 'Plurality Market Backend API',
      description: 'Backend API for the Plurality memory-NFT marketplace',
      version: "1.0.0",
    },
    tags: [
      {
        name: 'Auth',
        description: 'SIWE wallet authentication'
      },
      {
        name: 'AI-Context',
        description: 'AI context service'
      },
      {
        name: 'AI-Profile',
        description: 'AI profile (memory bucket) service'
      },
      {
        name: 'User-Account',
        description: 'User account management (info, deletion)'
      },
      {
        name: 'MCP',
        description: 'MCP server endpoints (semantic search)'
      },
      {
        name: 'Tokens',
        description: 'Personal Access Tokens for MCP clients'
      },
      {
        name: 'Blockchain',
        description: 'Mint, marketplace, and on-chain verification'
      }
    ],
    servers: [
      {
        url: process.env.PLURALITY_BACKEND || 'http://localhost:5000',
        description: ""
      }
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "Pass the plurality JWT token"
        }
      }
    }
  }
};

async function main() {
  await swaggerAutogen(swaggerConfig.outputFile, swaggerConfig.endpointsFiles, swaggerConfig.doc);
  console.log('Swagger JSON generated successfully');
}

main();

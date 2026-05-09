const swaggerAutogen = require('swagger-autogen')({ openapi: '3.0.0' });
const dotenv = require('dotenv');
dotenv.config();

const swaggerConfig = {
  outputFile: './src/swagger.json',
  endpointsFiles: ['./src/index.ts'],
  doc: {
    info: {
      title: 'Plurality API',
      description: 'Plurality Backend API Documentation',
      version: "1.0.0",
    },
    tags: [
      {
        name: 'Auth',
        description: 'Auth service'
      },
      {
        name: 'User-Onboarding',
        description: 'User onboarding service'
      },
      {
        name: 'AI-Context',
        description: 'AI context service'
      },
      {
        name: 'AI-Profile',
        description: 'AI profile service'
      },
      {
        name: 'User-Account',
        description: 'User account management (info, deletion)'
      },
      {
        name: 'OAuth-Provider',
        description: 'Hydra OAuth2/OIDC provider (login, consent, discovery, DCR)'
      },
      {
        name: 'MCP',
        description: 'MCP server endpoints (semantic search)'
      },
      {
        name: 'Access',
        description: 'Profile access management (grant, list, update, revoke)'
      },
      {
        name: 'Activity',
        description: 'Activity log for shared profiles'
      },
      {
        name: 'Notifications',
        description: 'User notifications (shared profile events)'
      },
      {
        name: 'Subscription',
        description: 'Subscription service'
      },
      {
        name: 'AppSumo',
        description: 'AppSumo lifecycle, license activation, and review prompt'
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

module.exports = {
    branches: ['main'],
    'plugins': [
      '@semantic-release/commit-analyzer',
      '@semantic-release/release-notes-generator',
      '@semantic-release/npm',
      [
        '@semantic-release/exec',
        {
          'prepareCmd': `
            docker build . --file Dockerfile --tag ghcr.io/web3-plurality/plurality-market-backend-pre:latest \\
            && docker push ghcr.io/web3-plurality/plurality-market-backend-pre:latest \\
            && docker tag ghcr.io/web3-plurality/plurality-market-backend-pre:latest ghcr.io/web3-plurality/plurality-market-backend-pre:\${nextRelease.version} \\
            && docker push ghcr.io/web3-plurality/plurality-market-backend-pre:\${nextRelease.version}
           `,
          'successCmd': 'echo "version=${nextRelease.version}" >> $GITHUB_OUTPUT'
        }
      ],
      '@semantic-release/github'
    ],
  };
  
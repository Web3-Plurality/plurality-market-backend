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
            docker build . --file Dockerfile --tag ghcr.io/web3-plurality/plurality-backend-api-pre:latest \\
            && docker push ghcr.io/web3-plurality/plurality-backend-api-pre:latest \\
            && docker tag ghcr.io/web3-plurality/plurality-backend-api-pre:latest ghcr.io/web3-plurality/plurality-backend-api-pre:\${nextRelease.version} \\
            && docker push ghcr.io/web3-plurality/plurality-backend-api-pre:\${nextRelease.version}
           `
        }
      ],
      '@semantic-release/git',
      '@semantic-release/github'
    ],
    'git': {
      'assets': ['package.json'],
      'message': 'chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}',
    }
  };
  
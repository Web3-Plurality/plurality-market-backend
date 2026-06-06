FROM node:20-slim

# Set up the working directory
WORKDIR /app

# Copy package.json and package-lock.json files
COPY package.json package-lock.json ./

# Install minimal system dependencies. (Past versions of this image pulled in
# ~30 headless-Chrome libs — libnss3, libgtk-3-0, libcups2, libxcomposite1,
# etc. — left over from a Puppeteer integration that no longer exists in
# the codebase. Those have been removed; only ca-certificates remains, for
# outbound HTTPS to the RPC + AI service.)
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js dependencies (npm ci uses the committed lockfile for reproducible builds)
RUN npm ci

# Copy the rest of the application code
COPY . ./

# The HTTP server reads PORT from .env / runtime env. Default to 5001 to match
# the rest of the market stack (UI → 5001, MCP → 5001, AI service → 5001 webhook).
ENV PORT=5001
EXPOSE 5001

# Set the command to run the application
CMD ["sh", "-c", "npm run swagger && npm run prod"]

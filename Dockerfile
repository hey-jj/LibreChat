# v0.7.8 - Based directly on the official project Dockerfile

# Base node image
FROM node:20-alpine AS node

# Install jemalloc and other tools as per the official Dockerfile
RUN apk add --no-cache jemalloc
RUN apk add --no-cache python3 py3-pip uv

# Set environment variable to use jemalloc
ENV LD_PRELOAD=/usr/lib/libjemalloc.so.2

# Add `uv` for extended MCP support
COPY --from=ghcr.io/astral-sh/uv:0.6.13 /uv /uvx /bin/
RUN uv --version

# Create non-root user and set up work directory
RUN mkdir -p /app && chown node:node /app
WORKDIR /app
USER node

# Copy all source code as the non-root user
COPY --chown=node:node . .

# ===================================================================
# Customization for GCP: Copy the Firebase Service Account Key into the image
# This is our first of two required additions.
COPY --chown=node:node firebase-service-account-key.json /app/firebase-service-account-key.json
# ===================================================================

# Run the official, multi-step build command
# We are NOT pruning production dependencies to ensure all scripts have what they need.
RUN \
    touch .env ; \
    mkdir -p /app/client/public/images /app/api/logs ; \
    npm config set fetch-retry-maxtimeout 600000 ; \
    npm config set fetch-retries 5 ; \
    npm config set fetch-retry-mintimeout 15000 ; \
    npm install --no-audit; \
    NODE_OPTIONS="--max-old-space-size=4096" npm run frontend; \
    npm cache clean --force

# ===================================================================
# Customization for GCP: Set the standard Google credential variable
# This is our second and final required addition.
ENV GOOGLE_APPLICATION_CREDENTIALS /app/firebase-service-account-key.json
# ===================================================================

# Expose the correct port
EXPOSE 3080

# Set the host for the server
ENV HOST=0.0.0.0

# Use the official, correct command to start the backend server
CMD ["npm", "run", "backend"]
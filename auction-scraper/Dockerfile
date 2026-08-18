FROM node:20-slim

RUN apt-get update && \
    apt-get install -y python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY src/ ./src/
COPY public/ ./public/
COPY certs/ ./certs/

# shop.cashconverters.co.nz omits the intermediate certificate from its TLS
# chain. Browsers fetch it automatically, Node does not — without this every
# request fails with UNABLE_TO_VERIFY_LEAF_SIGNATURE. Supplying the intermediate
# restores a complete chain with full verification still enabled.
ENV NODE_EXTRA_CA_CERTS=/app/certs/extra-ca.pem

RUN mkdir -p data

EXPOSE 3456

CMD ["node", "server.js"]

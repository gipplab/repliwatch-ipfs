# RepliWatch

Browser-based IPFS replication monitor. Queries delegated routing endpoints to discover providers for a list of CIDs, then flags under-replicated content as a "red list".

## What it does

- Scans CIDs against public IPFS routing endpoints (`delegated-ipfs.dev`, `cid.contact`)
- Shows provider (peer) count per CID
- Classifies CIDs as healthy, warning, or critical based on a configurable threshold
- Exports a red list of under-replicated CIDs

An example version can be tried at: [RepliWatch](https://ipfs.io/ipfs/bafybeigs3uk5xbvknxfnyr4murfsb3f4dtot7clon7qak34hgwyc5nzot4/)


## Setup

```
npm install
npm run dev
```

Open `http://localhost:3000`.

## Usage

1. The app loads CIDs from `public/cids.txt` on startup.
2. Click **Start Scan** to begin querying providers.
3. Use the filter bar to view critical / warning / healthy / error subsets.
4. Click any CID or peer ID to copy it to clipboard.
5. **Export Red List** downloads all under-replicated CIDs as a text file.

CIDs can also be added manually (paste or upload a `.txt` file) and are prioritized for scanning.

## Configuration

- **Red list threshold** — minimum provider count to consider a CID healthy (default: 3). Adjustable in the header.
- **`public/cids.txt`** — the default CID list loaded on startup. Replace with your own.

## Build

```
npm run build
```

Static output goes to `dist/`.

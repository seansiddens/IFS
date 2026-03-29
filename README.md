# ifs

## Requirements

- Node.js 18+
- A browser with WebGPU support (Chrome 113+, Edge 113+)

## Development

```sh
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

## Production build

```sh
npm run build
```

Output is written to `dist/` as static files.

To preview the build locally:

```sh
npm run preview
```

## Deploy to GitHub Pages

**Option A — manual push:**

```sh
npm install -D gh-pages
npm run build
npx gh-pages -d dist
```

Then go to repo Settings → Pages and set the source to the `gh-pages` branch.

**Option B — GitHub Actions (auto-deploy on push to `main`):**

Add `.github/workflows/deploy.yml`:

```yaml
name: Deploy
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci && npm run build
      - uses: actions/deploy-pages@v4
        with: { artifact_name: github-pages, path: dist }
```

If the site is served from a sub-path (e.g. `https://user.github.io/repo/`), create `vite.config.ts`:

```ts
import { defineConfig } from "vite";
export default defineConfig({ base: "/repo/" });
```

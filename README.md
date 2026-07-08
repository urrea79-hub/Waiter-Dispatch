# Waiter Dispatch Board — Parkway Family Kia

Round-robin waiter dispatch for the service drive. One shared board, live on every PC.

## Deploy (one time, ~10 minutes)

1. Create a free account at github.com (if you don't have one).
2. On GitHub: New repository -> name it `waiter-dispatch` -> Create.
3. Click "uploading an existing file" and drag ALL contents of this folder in
   (index.html goes inside a `public` folder, board.mjs inside `netlify/functions` —
   keep the folder structure exactly as-is). Commit.
   Tip: GitHub's drag-and-drop keeps folders if you drag the folders themselves.
4. Create a free account at netlify.com -> Add new site -> Import an existing project -> GitHub -> pick `waiter-dispatch`.
5. Leave all build settings as detected (publish directory: `public`). Deploy.
6. Netlify gives you a URL like `https://something.netlify.app`.
   Optional: Site settings -> Change site name to something like `parkway-dispatch`.

Send that URL to the advisors and pull it up on the shop monitor. Done — no accounts needed for anyone but you.

## Notes

- State lives in Netlify Blobs, tied to this site. Free tier is far more than enough.
- All rotation logic runs server-side, so simultaneous clicks can't double-assign.
- Screens refresh every 3 seconds.

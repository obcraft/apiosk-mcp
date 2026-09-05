# Connector branding

The Apiosk connector uses the same transparent a as the app sidebar and website favicon. Light mode shows black ink; dark mode shows white ink. The canvas and letter counter stay transparent: no tile, border or glow.

The live MCP initialize response, discovery server card and server.json share the SVG and theme-labelled 512px PNG icons. dxt.json uses the adaptive SVG. Versioned URLs prevent reuse of the old purple artwork. The legacy logo-optimized-light.png URL remains available with the transparent black mark and revalidation headers.

Assets live in assets/brand and ship in both the npm package and Docker image. Clients that snapshot connector metadata need to refresh the connection after deployment. Published directory listings may use a separately uploaded logo; changing MCP metadata does not confirm their displayed artwork has changed.

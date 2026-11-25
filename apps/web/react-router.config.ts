import type { Config } from "@react-router/dev/config";

export default {
  ssr: true,
  // Opened through Coder's proxy, a page's Origin is the workspace's address
  // while the server sees its own host: React Router would turn down every
  // form (the "Fetch" button) as coming from another site.
  allowedActionOrigins: ["*.coder.internal.limbic.ai"],
} satisfies Config;

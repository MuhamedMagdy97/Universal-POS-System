"use client";

import { createAuthClient } from "better-auth/react";

// Same-origin client; the server derives tenant context from the session.
export const authClient = createAuthClient();

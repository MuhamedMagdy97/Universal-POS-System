import { Suspense } from "react";
import { LoginForm } from "./login-form";

export default function LoginPage() {
  return (
    <>
      <h1 className="text-2xl font-semibold">Sign in</h1>
      <Suspense fallback={<p className="text-muted">Loading…</p>}>
        <LoginForm />
      </Suspense>
    </>
  );
}

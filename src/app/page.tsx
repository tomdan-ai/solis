"use client";

import { startRegistration } from "@simplewebauthn/browser";
import { FormEvent, useState } from "react";

type Screen = "welcome" | "verify" | "wallet";

export default function Home() {
  const [screen, setScreen] = useState<Screen>("welcome");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [sendPhone, setSendPhone] = useState("");
  const [sendAmount, setSendAmount] = useState("");
  const [recipientState, setRecipientState] = useState<"idle" | "found" | "new">("idle");

  async function requestCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/auth/otp/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not send code");
      setMessage(data.devOnly?.code ? `Demo code: ${data.devOnly.code}` : "Code sent. Check your messages.");
      setScreen("verify");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not send code");
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/auth/otp/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, code }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not verify code");
      setSessionId(data.sessionId);
      setMessage("Create a passkey to secure your wallet...");
      const optionsResponse = await fetch("/api/auth/passkey/options", {
        method: "POST",
        headers: { Authorization: `Bearer ${data.sessionId}` },
      });
      const options = (await optionsResponse.json()) as Parameters<typeof startRegistration>[0]["optionsJSON"];
      if (!optionsResponse.ok) throw new Error(optionsResponse.statusText || "Could not start passkey setup");
      const passkey = await startRegistration({ optionsJSON: options });
      const passkeyResponse = await fetch("/api/auth/passkey/verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${data.sessionId}`,
        },
        body: JSON.stringify(passkey),
      });
      const passkeyData = await passkeyResponse.json();
      if (!passkeyResponse.ok) throw new Error(passkeyData.error ?? "Could not register passkey");
      setScreen("wallet");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not verify code");
    } finally {
      setBusy(false);
    }
  }

  async function resolveRecipient(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/api/resolve?phone=${encodeURIComponent(sendPhone)}`, {
        headers: { Authorization: `Bearer ${sessionId}` },
      });
      setRecipientState(response.ok ? "found" : "new");
    } catch {
      setMessage("Recipient lookup failed. Check the number and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (screen === "wallet") {
    return (
      <main className="app-shell wallet-shell">
        <header className="topbar"><span className="wordmark">solis<span>.</span></span><span className="network-dot">Testnet connected</span></header>
        <section className="wallet-hero">
          <div><p className="eyebrow">Available balance</p><h1>$0.00 <small>USDC</small></h1><p className="muted">Your sponsored wallet is ready.</p></div>
          <button className="avatar" aria-label="Open profile">{phone.slice(-2) || "••"}</button>
        </section>
        <section className="action-grid"><button className="action-card primary" onClick={() => document.getElementById("send-phone")?.focus()}><strong>Send</strong><span>Pay a phone number</span></button><button className="action-card" onClick={() => setMessage("Share your phone number to receive USDC.")}><strong>Receive</strong><span>Use your Solis ID</span></button></section>
        <section className="panel send-panel"><div className="panel-heading"><div><p className="eyebrow">New payment</p><h2>Send USDC</h2></div><span className="sponsored">Fees sponsored</span></div>
          <form onSubmit={resolveRecipient} className="send-form"><label htmlFor="send-phone">Recipient phone</label><input id="send-phone" value={sendPhone} onChange={(event) => { setSendPhone(event.target.value); setRecipientState("idle"); }} placeholder="+1 555 123 4567" inputMode="tel" required /><label htmlFor="send-amount">Amount</label><div className="amount-input"><span>$</span><input id="send-amount" value={sendAmount} onChange={(event) => setSendAmount(event.target.value)} placeholder="0.00" inputMode="decimal" required /></div><button className="button button-dark" disabled={busy}>{busy ? "Looking up..." : "Continue"}</button></form>
          {recipientState !== "idle" && <div className={`recipient-note ${recipientState}`}><strong>{recipientState === "found" ? "Solis wallet found" : "They will need to claim"}</strong><span>{recipientState === "found" ? "Ready for a passkey-confirmed transfer." : "This payment will wait safely in escrow until they join."}</span></div>}
        </section>
        <section className="panel activity"><div className="panel-heading"><div><p className="eyebrow">Activity</p><h2>Recent payments</h2></div><span className="muted">No payments yet</span></div><div className="empty-state">Your first payment will appear here.</div></section>
        {message && <p className="toast">{message}</p>}
      </main>
    );
  }

  return (
    <main className="auth-shell"><div className="auth-art"><span className="wordmark">solis<span>.</span></span><div className="art-copy"><p className="eyebrow">Phone-native payments on Stellar</p><h1>Money should move as easily as a message.</h1><p>Send USDC to a phone number. No seed phrases. No XLM. Just your passkey.</p></div><span className="art-caption">A simpler way to stay in motion.</span></div>
      <section className="auth-panel"><div className="mobile-wordmark wordmark">solis<span>.</span></div>{screen === "welcome" ? <><div className="step-count">01 <span>/ 02</span></div><h2>Start with your phone</h2><p className="muted intro">We&apos;ll send a one-time code to make your wallet yours.</p><form onSubmit={requestCode} className="auth-form"><label htmlFor="phone">Mobile number</label><input id="phone" value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="+1 555 123 4567" inputMode="tel" autoComplete="tel" required /><button className="button button-dark" disabled={busy}>{busy ? "Sending..." : "Send me a code"}</button></form></> : <><div className="step-count">02 <span>/ 02</span></div><h2>Enter your code</h2><p className="muted intro">A six-digit code is on its way to {phone}.</p><form onSubmit={verifyCode} className="auth-form"><label htmlFor="code">Verification code</label><input id="code" className="code-input" value={code} onChange={(event) => setCode(event.target.value)} placeholder="000000" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required /><button className="button button-dark" disabled={busy}>{busy ? "Verifying..." : "Open my wallet"}</button></form><button className="text-button" onClick={() => setScreen("welcome")}>Use a different number</button></>}{message && <p className="form-message">{message}</p>}<p className="legal">By continuing, you agree to the Solis terms. Your wallet is self-custodial.</p></section>
    </main>
  );
}

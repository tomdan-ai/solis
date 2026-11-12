"use client";

import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { formatUsdc, getKit, toStroops } from "@/lib/client/kit";

type Screen = "loading" | "welcome" | "verify" | "passkey" | "passkeyLogin" | "deploying" | "wallet";
type Tab = "home" | "receive" | "settings";
type Payment = {
  id: string;
  onchainId: string;
  senderWallet: string;
  phoneHash: string;
  amount: string;
  status: "PENDING" | "CLAIMED" | "REFUNDED";
  expiresAt: string;
};
type Transfer = { id: string; kind: string; fromWallet: string | null; toWallet: string | null; amount: string; createdAt: string };
type Operation =
  | { kind: "transfer"; recipient: string; amount: string }
  | { kind: "deposit"; phoneHash: string; amount: string; expiresAt: number }
  | { kind: "claim"; paymentId: string }
  | { kind: "refund"; paymentId: string };

// The server stores only a hash of the phone number, so this browser remembers the
// number you signed in with, purely so the Receive tab can show it.
const PHONE_KEY = "solis_phone";

function toE164(raw: string): string {
  const trimmed = raw.trim();
  let digits = trimmed.replace(/^\+/, "").replace(/\D/g, "");
  if (!trimmed.startsWith("+") && /^0\d{10}$/.test(digits)) digits = `234${digits.slice(1)}`;
  return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : "";
}

function formatPhone(e164: string): string {
  const m = /^\+234(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `+234 ${m[1]} ${m[2]} ${m[3]}` : e164;
}

function loadPhone(): string {
  try { return localStorage.getItem(PHONE_KEY) ?? ""; } catch { return ""; }
}
function savePhone(value: string) {
  try { localStorage.setItem(PHONE_KEY, value); } catch { /* storage unavailable */ }
}
function clearPhone() {
  try { localStorage.removeItem(PHONE_KEY); } catch { /* storage unavailable */ }
}

const REFUND_WINDOW_SECONDS = 7 * 24 * 60 * 60;

async function api<T = Record<string, unknown>>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${response.status})`);
  return data as T;
}

/** prepare (server simulates) -> passkey signs auth entries -> sponsor proxy submits. */
async function submitOperation(operation: Operation, custodial: boolean): Promise<string> {
  if (custodial) {
    // Demo mode: the server holds the key, applies the policy, signs and submits.
    const result = await api<{ hash: string }>("/api/transactions/send", { method: "POST", body: JSON.stringify({ operation }) });
    return result.hash;
  }
  const kit = getKit();
  const prepared = await api<{ func: string; auth: string[]; latestLedger: number }>("/api/transactions/prepare", {
    method: "POST",
    body: JSON.stringify({ operation }),
  });
  const auth: string[] = [];
  for (const entry of prepared.auth) {
    auth.push(await kit.signAuthEntry(entry, { expiration: prepared.latestLedger + 100, contextRuleIds: [0] }));
  }
  const result = await api<{ data?: { hash?: string } }>("/api/relay/proxy", {
    method: "POST",
    body: JSON.stringify({ func: prepared.func, auth }),
  });
  return result.data?.hash ?? "";
}

function timeLeft(expiresAt: string, now: number): string {
  const ms = new Date(expiresAt).getTime() - now;
  if (ms <= 0) return "Expired";
  const hours = Math.floor(ms / 3_600_000);
  return hours >= 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h left` : `${hours}h ${Math.floor((ms % 3_600_000) / 60_000)}m left`;
}

export default function Home() {
  const [screen, setScreen] = useState<Screen>("loading");
  const [tab, setTab] = useState<Tab>("home");
  const [phone, setPhone] = useState("");
  const [myPhone, setMyPhone] = useState("");
  const [code, setCode] = useState("");
  const [wallet, setWallet] = useState("");
  const [network, setNetwork] = useState("testnet");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [balance, setBalance] = useState("0");
  const [xlm, setXlm] = useState("0");
  const [simulated, setSimulated] = useState(false);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [sendPhone, setSendPhone] = useState("");
  const [sendAmount, setSendAmount] = useState("");
  const [recipient, setRecipient] = useState<{ registered: boolean; walletAddress: string | null; phoneHash: string } | null>(null);
  const [copied, setCopied] = useState("");
  const [custodial, setCustodial] = useState(false);
  const [hasPasskey, setHasPasskey] = useState(false);
  const [now, setNow] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const [bal, pays] = await Promise.all([
        api<{ balance: string; xlm: string; simulated?: boolean }>("/api/balance"),
        api<{ payments: Payment[]; transfers?: Transfer[] }>("/api/payments"),
      ]);
      setBalance(bal.balance);
      setXlm(bal.xlm ?? "0");
      setSimulated(Boolean(bal.simulated));
      setPayments(pays.payments);
      setTransfers(pays.transfers ?? []);
    } catch {
      /* keep stale data; surfaced on next action */
    }
  }, []);

  const deployWallet = useCallback(async (serverHeld: boolean = custodial) => {
    setScreen("deploying");
    setMessage(serverHeld ? "Creating your wallet..." : "Creating your passkey and deploying your wallet...");
    try {
      if (serverHeld) {
        const created = await api<{ walletAddress: string }>("/api/wallets/create", { method: "POST" });
        setWallet(created.walletAddress);
        setMessage("");
        setScreen("wallet");
        return;
      }
      const kit = getKit();
      const created = await Promise.race([
        kit.createWallet("Solis", phone || "Solis wallet", { autoSubmit: true }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("No passkey prompt appeared. Open this page in Chrome or Safari (not an editor preview) and try again.")), 90_000),
        ),
      ]);
      setMessage("Linking your phone number...");
      await api("/api/wallets/register", { method: "POST", body: JSON.stringify({ walletAddress: created.contractId }) });
      setWallet(created.contractId);
      setMessage("");
      setScreen("wallet");
    } catch (error) {
      console.error("Wallet setup failed:", error);
      setMessage(error instanceof Error ? error.message : "Wallet setup failed");
      setScreen("passkey");
    }
  }, [phone, custodial]);

  useEffect(() => {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
    api<{ walletAddress: string | null; network: string; custodial: boolean; hasPasskey: boolean }>("/api/auth/session")
      .then((session) => {
        setNetwork(session.network);
        setCustodial(session.custodial);
        setMyPhone(loadPhone());
        setHasPasskey(session.hasPasskey);
        if (session.walletAddress) {
          setWallet(session.walletAddress);
          setScreen("wallet");
        } else {
          setScreen("passkey");
        }
      })
      .catch(() => setScreen("welcome"));
  }, []);

  useEffect(() => {
    if (screen !== "wallet") return;
    const first = setTimeout(() => { setNow(Date.now()); refresh(); }, 0);
    const timer = setInterval(() => { setNow(Date.now()); refresh(); }, 15_000);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, [screen, refresh]);

  async function requestCode(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      await api("/api/auth/otp/request", { method: "POST", body: JSON.stringify({ phone }) });
      setScreen("verify");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not send code");
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const data = await api<{ walletAddress: string | null; custodial: boolean; passkeyRequired?: boolean; hasPasskey?: boolean }>("/api/auth/otp/verify", {
        method: "POST",
        body: JSON.stringify({ phone, code }),
      });
      setCustodial(data.custodial);
      const e164 = toE164(phone);
      if (e164) {
        savePhone(e164);
        setMyPhone(e164);
      }
      if (data.passkeyRequired) {
        // Second factor: OTP only earned a pending session; the passkey completes the login.
        setScreen("passkeyLogin");
        return;
      }
      setHasPasskey(Boolean(data.hasPasskey));
      if (data.custodial && !data.hasPasskey) {
        // First time with server-held wallets: create a passkey (then the wallet, if needed).
        if (data.walletAddress) setWallet(data.walletAddress);
        setScreen("passkey");
        return;
      }
      if (data.walletAddress) {
        setWallet(data.walletAddress);
        setScreen("wallet");
      } else if (data.custodial) {
        // Demo mode: no passkey step; the server creates the wallet.
        await deployWallet(true);
      } else {
        // Passkey creation must start from a direct click, so it gets its own screen.
        setScreen("passkey");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not verify code");
    } finally {
      setBusy(false);
    }
  }

  async function getTestUsdc() {
    setBusy(true);
    setMessage("");
    try {
      await api("/api/sim/faucet", { method: "POST" });
      await refresh();
      setMessage("Added 100 test USDC.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not add test USDC");
    } finally {
      setBusy(false);
    }
  }

  async function registerPasskey() {
    const options = await api<Parameters<typeof startRegistration>[0]["optionsJSON"]>("/api/auth/passkey/options", { method: "POST" });
    const credential = await startRegistration({ optionsJSON: options });
    await api("/api/auth/passkey/verify", { method: "POST", body: JSON.stringify(credential) });
    setHasPasskey(true);
  }

  function passkeyMessage(error: unknown, fallback: string): string {
    if (error instanceof Error && error.name === "NotAllowedError") {
      return "The passkey prompt was cancelled or did not appear. Use Chrome or Safari (not an editor preview) and try again.";
    }
    return error instanceof Error ? error.message : fallback;
  }

  // Must start from a direct click: browsers refuse passkey prompts that are not user-initiated.
  async function enrollPasskey() {
    setBusy(true);
    setMessage("");
    try {
      if (!hasPasskey) await registerPasskey();
      if (wallet) setScreen("wallet");
      else await deployWallet(true);
    } catch (error) {
      setMessage(passkeyMessage(error, "Could not create a passkey"));
    } finally {
      setBusy(false);
    }
  }

  async function loginWithPasskey() {
    setBusy(true);
    setMessage("");
    try {
      const options = await api<Parameters<typeof startAuthentication>[0]["optionsJSON"]>("/api/auth/passkey/login/options", { method: "POST" });
      const assertion = await startAuthentication({ optionsJSON: options });
      const result = await api<{ walletAddress: string | null }>("/api/auth/passkey/login/verify", { method: "POST", body: JSON.stringify(assertion) });
      setHasPasskey(true);
      if (result.walletAddress) {
        setWallet(result.walletAddress);
        setScreen("wallet");
      } else {
        await deployWallet(true);
      }
    } catch (error) {
      setMessage(passkeyMessage(error, "Passkey sign-in failed"));
    } finally {
      setBusy(false);
    }
  }

  async function addPasskey() {
    setBusy(true);
    setMessage("");
    try {
      await registerPasskey();
      setMessage("Passkey saved. You will use it the next time you log in.");
    } catch (error) {
      setMessage(passkeyMessage(error, "Could not create a passkey"));
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    if (!custodial) {
      // Passkey wallets: also drop the kit's stored wallet session so the next login starts clean.
      try { await getKit().disconnect(); } catch { /* nothing stored */ }
    }
    clearPhone();
    setMyPhone("");
    setWallet("");
    setPayments([]);
    setTab("home");
    setScreen("welcome");
  }

  async function lookupRecipient(event: FormEvent) {
    event.preventDefault();
    setMessage("");
    if (!toStroops(sendAmount)) return setMessage("Enter a valid USDC amount (up to 7 decimals).");
    setBusy(true);
    try {
      setRecipient(await api(`/api/resolve?phone=${encodeURIComponent(sendPhone)}`));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Recipient lookup failed");
    } finally {
      setBusy(false);
    }
  }

  async function confirmSend() {
    const amount = toStroops(sendAmount);
    if (!recipient || !amount) return;
    setBusy(true);
    setMessage("Confirm with your passkey...");
    try {
      const operation: Operation = recipient.registered && recipient.walletAddress
        ? { kind: "transfer", recipient: recipient.walletAddress, amount }
        : { kind: "deposit", phoneHash: recipient.phoneHash, amount, expiresAt: Math.floor(Date.now() / 1000) + REFUND_WINDOW_SECONDS };
      await submitOperation(operation, custodial);
      setMessage(recipient.registered ? "Payment sent." : "Payment held in escrow until they join.");
      setRecipient(null);
      setSendPhone("");
      setSendAmount("");
      setTimeout(refresh, 4000);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Payment failed");
    } finally {
      setBusy(false);
    }
  }

  async function settle(kind: "claim" | "refund", payment: Payment) {
    setBusy(true);
    setMessage(`Confirm ${kind} with your passkey...`);
    try {
      await submitOperation({ kind, paymentId: payment.onchainId }, custodial);
      setMessage(kind === "claim" ? "Claimed. Funds are on their way to your wallet." : "Refund submitted.");
      setTimeout(refresh, 4000);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `Could not ${kind}`);
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string, key: string) {
    await navigator.clipboard.writeText(text).catch(() => {});
    setCopied(key);
    setTimeout(() => setCopied(""), 1500);
  }

  if (screen === "loading") return <main className="app-shell"><p className="muted">Loading...</p></main>;

  if (screen === "wallet") {
    const incoming = payments.filter((p) => p.senderWallet !== wallet && p.status === "PENDING");
    return (
      <main className="app-shell wallet-shell">
        <header className="topbar"><span className="wordmark">solis<span>.</span></span><span style={{ display: "flex", alignItems: "center", gap: "14px" }}><span className="network-dot">{network === "testnet" ? "Testnet" : "Mainnet"}</span><button className="text-button" onClick={logout}>Log out</button></span></header>
        <nav className="action-grid" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
          {(["home", "receive", "settings"] as Tab[]).map((t) => (
            <button key={t} className={`action-card ${tab === t ? "primary" : ""}`} onClick={() => setTab(t)}><strong>{t[0].toUpperCase() + t.slice(1)}</strong></button>
          ))}
        </nav>

        {tab === "home" && (
          <>
            <section className="wallet-hero"><div><p className="eyebrow">Available balance</p><h1>${formatUsdc(balance)} <small>USDC</small></h1><p className="muted">+ {formatUsdc(xlm)} XLM for network fees</p>
              {simulated && <p className="muted">USDC is simulated in this demo.</p>}<p className="muted">{wallet.slice(0, 6)}…{wallet.slice(-4)}</p></div></section>

            {simulated && <button className="button button-dark" disabled={busy} onClick={getTestUsdc}>Get 100 test USDC</button>}

            <section className="panel"><div className="panel-heading"><div><p className="eyebrow">Assets</p><h2>Wallet holdings</h2></div></div>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead><tr><th style={{ textAlign: "left" }}>Asset</th><th style={{ textAlign: "right" }}>Balance</th></tr></thead>
                <tbody>
                  <tr><td>XLM <span className="muted">(network fees)</span></td><td style={{ textAlign: "right" }}>{formatUsdc(xlm)}</td></tr>
                  <tr><td>USDC</td><td style={{ textAlign: "right" }}>{formatUsdc(balance)}</td></tr>
                </tbody>
              </table>
            </section>

            {incoming.length > 0 && (
              <section className="panel"><div className="panel-heading"><div><p className="eyebrow">Waiting for you</p><h2>Claim payments</h2></div></div>
                {incoming.map((p) => (
                  <div key={p.id} className="recipient-note found"><strong>${formatUsdc(p.amount)} USDC</strong><span>{timeLeft(p.expiresAt, now)}</span>
                    <button className="button button-dark" disabled={busy} onClick={() => settle("claim", p)}>Claim</button></div>
                ))}
              </section>
            )}

            <section className="panel send-panel"><div className="panel-heading"><div><p className="eyebrow">New payment</p><h2>Send USDC</h2></div><span className="sponsored">Fees sponsored</span></div>
              <form onSubmit={lookupRecipient} className="send-form">
                <label htmlFor="send-phone">Recipient phone</label>
                <input id="send-phone" value={sendPhone} onChange={(e) => { setSendPhone(e.target.value); setRecipient(null); }} placeholder="0803 123 4567" inputMode="tel" required />
                <label htmlFor="send-amount">Amount</label>
                <div className="amount-input"><span>$</span><input id="send-amount" value={sendAmount} onChange={(e) => { setSendAmount(e.target.value); setRecipient(null); }} placeholder="0.00" inputMode="decimal" required /></div>
                {!recipient && <button className="button button-dark" disabled={busy}>{busy ? "Looking up..." : "Continue"}</button>}
              </form>
              {recipient && (
                <div className={`recipient-note ${recipient.registered ? "found" : "new"}`}>
                  <strong>{recipient.registered ? "Solis wallet found" : "They will need to claim"}</strong>
                  <span>{recipient.registered ? `Send $${sendAmount} USDC directly.` : `$${sendAmount} waits in escrow until they join. You can refund it after it expires.`}</span>
                  <button className="button button-dark" disabled={busy} onClick={confirmSend}>{busy ? "Waiting for passkey..." : "Confirm with passkey"}</button>
                </div>
              )}
            </section>

            <section className="panel activity"><div className="panel-heading"><div><p className="eyebrow">Activity</p><h2>Recent payments</h2></div></div>
              {payments.length === 0 && transfers.length === 0 && <div className="empty-state">Your first payment will appear here.</div>}
              {transfers.filter((t) => t.kind === "transfer" || t.kind === "faucet").map((t) => (
                <div key={t.id} className="recipient-note">
                  <strong>{t.kind === "faucet" ? "Test USDC added" : t.fromWallet === wallet ? "Sent" : "Received"} ${formatUsdc(t.amount)} USDC</strong>
                  <span>{new Date(t.createdAt).toLocaleString()}</span>
                </div>
              ))}
              {payments.map((p) => {
                const mine = p.senderWallet === wallet;
                const expired = new Date(p.expiresAt).getTime() <= now;
                return (
                  <div key={p.id} className="recipient-note">
                    <strong>{mine ? "Sent" : "Received"} ${formatUsdc(p.amount)} USDC</strong>
                    <span>{p.status === "PENDING" ? (expired ? "Expired" : `Pending · ${timeLeft(p.expiresAt, now)}`) : p.status.toLowerCase()}</span>
                    {mine && p.status === "PENDING" && expired && <button className="button button-dark" disabled={busy} onClick={() => settle("refund", p)}>Refund</button>}
                  </div>
                );
              })}
            </section>
          </>
        )}

        {tab === "receive" && (
          <section className="panel"><div className="panel-heading"><div><p className="eyebrow">Your Solis ID</p><h2>{myPhone ? formatPhone(myPhone) : "Phone number not shown"}</h2></div></div>
            <p className="muted">{myPhone ? "Anyone can pay you with just this phone number." : "We store only a hash of your number, not the number itself. Log out and sign in again on this device to show it here."}</p>
            {myPhone && <button className="button button-dark" onClick={() => copy(myPhone, "phone")}>{copied === "phone" ? "Copied" : "Copy phone number"}</button>}
            <p className="eyebrow">Wallet address</p>
            <p className="muted" style={{ wordBreak: "break-all" }}>{wallet}</p>
            <button className="text-button" onClick={() => copy(wallet, "wallet")}>{copied === "wallet" ? "Copied" : "Copy wallet address"}</button>
            {myPhone && typeof navigator !== "undefined" && "share" in navigator && <button className="text-button" onClick={() => navigator.share({ title: "Pay me on Solis", text: `Send me USDC on Solis: ${formatPhone(myPhone)}` }).catch(() => {})}>Share</button>}
          </section>
        )}

        {tab === "settings" && (
          <section className="panel"><div className="panel-heading"><div><p className="eyebrow">Settings</p><h2>Wallet</h2></div></div>
            <p className="muted">Network: {network}</p>
            <p className="muted" style={{ wordBreak: "break-all" }}>Address: {wallet}</p>
            {custodial
              ? <><p className="muted">Demo wallet: the server holds this wallet&apos;s key on testnet. This mode is disabled in production.</p>
                <p className="muted">Passkey login: {hasPasskey ? "enabled" : "not set up"}</p>
                <button className="button button-dark" disabled={busy} onClick={addPasskey}>{hasPasskey ? "Add another passkey" : "Set up passkey login"}</button></>
              : <><p className="muted">Recovery: your passkey is the only key to this wallet. If every device and synced passkey is lost, funds cannot be recovered in this MVP.</p>
                <button className="button button-dark" disabled={busy} onClick={async () => {
                  setBusy(true);
                  try { await getKit().connectWallet({ prompt: true }); setMessage("Passkey verified."); }
                  catch (e) { setMessage(e instanceof Error ? e.message : "Could not reach passkey"); }
                  finally { setBusy(false); }
                }}>Verify passkey</button></>}
            <button className="text-button" onClick={logout}>Log out</button>
          </section>
        )}
        {message && <p className="toast">{message}</p>}
      </main>
    );
  }

  return (
    <main className="auth-shell"><div className="auth-art"><span className="wordmark">solis<span>.</span></span><div className="art-copy"><p className="eyebrow">Phone-native payments on Stellar</p><h1>Money should move as easily as a message.</h1><p>Send USDC to a phone number. No seed phrases. No XLM. Just your passkey.</p></div><span className="art-caption">A simpler way to stay in motion.</span></div>
      <section className="auth-panel"><div className="mobile-wordmark wordmark">solis<span>.</span></div>
        {screen === "welcome" && <><div className="step-count">01 <span>/ 02</span></div><h2>Start with your phone</h2><p className="muted intro">We&apos;ll send a one-time code to make your wallet yours.</p>
          <form onSubmit={requestCode} className="auth-form"><label htmlFor="phone">Mobile number</label><input id="phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="0803 123 4567" inputMode="tel" autoComplete="tel" required /><button className="button button-dark" disabled={busy}>{busy ? "Sending..." : "Send me a code"}</button></form></>}
        {screen === "verify" && <><div className="step-count">02 <span>/ 02</span></div><h2>Enter your code</h2><p className="muted intro">A six-digit code is on its way to {phone || "your phone"}.</p>
          <form onSubmit={verifyCode} className="auth-form"><label htmlFor="code">Verification code</label><input id="code" className="code-input" value={code} onChange={(e) => setCode(e.target.value)} placeholder="000000" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required /><button className="button button-dark" disabled={busy}>{busy ? "Verifying..." : "Open my wallet"}</button></form>
          <button className="text-button" onClick={() => setScreen("welcome")}>Use a different number</button>
          </>}
        {screen === "passkey" && (custodial
          ? <><div className="step-count">03 <span>/ 03</span></div><h2>Secure your account</h2><p className="muted intro">Create a passkey with Touch ID, Face ID or your device PIN. You will use it every time you log in.</p>
            <button className="button button-dark" disabled={busy} onClick={enrollPasskey}>{busy ? "Waiting for passkey..." : "Create passkey"}</button>
            {wallet && <button className="text-button" onClick={() => setScreen("wallet")}>Skip for now</button>}</>
          : <><div className="step-count">03 <span>/ 03</span></div><h2>Create your wallet</h2><p className="muted intro">{custodial ? "Your phone is verified. We'll create a testnet demo wallet for you." : "Your phone is verified. Next, create a passkey. It is the only key to your wallet, so it stays on your device."}</p><button className="button button-dark" onClick={() => deployWallet()}>{custodial ? "Create my wallet" : "Create passkey & wallet"}</button></>)}
        {screen === "passkeyLogin" && <><h2>Unlock with your passkey</h2><p className="muted intro">Your number is verified. Use your passkey to finish signing in.</p>
          <button className="button button-dark" disabled={busy} onClick={loginWithPasskey}>{busy ? "Waiting for passkey..." : "Unlock with passkey"}</button>
          <button className="text-button" onClick={() => { setMessage(""); setScreen("welcome"); }}>Use a different number</button></>}
        {screen === "deploying" && <><h2>Setting up your wallet</h2><p className="muted intro">Approve the passkey prompt, then we&apos;ll deploy your wallet. This takes a few seconds.</p><button className="text-button" onClick={() => { setMessage(""); setScreen("verify"); }}>Cancel</button></>}
        {message && <p className="form-message">{message}</p>}
        <p className="legal">By continuing, you agree to the Solis terms. Your wallet is self-custodial.</p>
      </section>
    </main>
  );
}

import { useState } from "react";

interface Props {
  onSubmit: (password: string) => void;
  onCancel: () => void;
}

export function PasswordRetry({ onSubmit, onCancel }: Props) {
  const [password, setPassword] = useState("");

  return (
    <form
      className="password-retry"
      onSubmit={(e) => {
        e.preventDefault();
        if (password !== "") onSubmit(password);
      }}
    >
      <label htmlFor="retry-password">Password</label>
      <input
        id="retry-password"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoFocus
      />
      {/* Saved to the Keychain on success, so this asks at most once. */}
      <div className="editor-actions">
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" disabled={password === ""}>
          Connect
        </button>
      </div>
    </form>
  );
}

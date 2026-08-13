import { useState } from "react";

interface Props {
  initial: string;
  depth: number;
  placeholder?: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}

/**
 * Inline text field used for both renaming an existing row and naming
 * a row that is still being created (an empty `initial` plus a
 * `placeholder` reads as "type a name"). Enter commits, Escape
 * cancels, blur commits when there is text and cancels when there
 * isn't — so clicking away from an empty "new query" field quietly
 * drops it instead of leaving something unnamed in the tree.
 */
export function RenameInput({ initial, depth, placeholder, onCommit, onCancel }: Props) {
  const [value, setValue] = useState(initial);

  return (
    <input
      className="rename-input"
      style={{ marginLeft: 8 + depth * 12 }}
      value={value}
      placeholder={placeholder}
      autoFocus
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => (value.trim() ? onCommit(value) : onCancel())}
      onKeyDown={(e) => {
        if (e.key === "Enter" && value.trim()) onCommit(value);
        if (e.key === "Escape") onCancel();
      }}
    />
  );
}

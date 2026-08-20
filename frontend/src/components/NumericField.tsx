// src/components/NumericField.tsx
//
// The one numeric text input every range-constrained parameter uses.
//
// The point of it is that typing is not editing: a half-typed number is not a
// value, and an empty box is a normal thing to pass through on the way to
// "14". So while the field has focus it holds whatever the user typed --
// including nothing at all -- and only values that already satisfy the
// constraints are committed as they are typed. Blur is what settles the
// field: an empty or unparseable box falls back to `emptyValue` (the minimum
// by default) and an out-of-range one is clamped, and only then does the
// value reach the caller.

import React, { useEffect, useState } from "react";
import { TextField, TextFieldProps } from "@mui/material";

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

// The empty string is not 0 here (Number("") is), and neither is whitespace.
const parseDraft = (draft: string): number =>
  draft.trim() === "" ? NaN : Number(draft);

export type NumericFieldProps = Omit<
  TextFieldProps,
  "value" | "onChange" | "type" | "defaultValue"
> & {
  /** The committed value. `undefined` shows an empty box (see `placeholder`). */
  value: number | undefined;
  min?: number;
  max?: number;
  step?: number;
  /** Applied to a parsed value before it is committed. */
  round?: (value: number) => number;
  /** Committed when the box is left empty on blur. Defaults to `min`. */
  emptyValue?: number;
  /** Called only with sanitized, in-range values. */
  onChange: (value: number) => void;
};

export const NumericField: React.FC<NumericFieldProps> = ({
  value,
  min = -Infinity,
  max = Infinity,
  step,
  round = (v) => v,
  emptyValue,
  onChange,
  error,
  inputProps,
  onBlur,
  onFocus,
  ...textFieldProps
}) => {
  const [draft, setDraft] = useState<string>(() => format(value));
  // Focus, not the draft, decides who owns the text: an echo of our own write
  // (or another client's) must not rewrite the box under the caret.
  const [focused, setFocused] = useState(false);
  // Blur only commits when the user actually typed something, so tabbing
  // through an untouched empty box doesn't fill it in.
  const [edited, setEdited] = useState(false);

  useEffect(() => {
    if (!focused) setDraft(format(value));
  }, [value, focused]);

  // An empty box is never an error: it is either mid-edit or about to be
  // settled by blur. Only a number the constraints reject gets flagged.
  const parsed = parseDraft(draft);
  const draftInvalid = !isNaN(parsed) && (parsed < min || parsed > max);

  const handleChange = (raw: string) => {
    setDraft(raw);
    setEdited(true);
    const next = parseDraft(raw);
    // Empty, half-typed ("1" on the way to "14" under a min of 10), or
    // over-long input is left alone until blur settles it.
    if (isNaN(next) || next < min || next > max) return;
    const rounded = round(next);
    if (rounded !== value) onChange(rounded);
  };

  const settle = () => {
    if (!edited) return format(value);
    const next = parseDraft(draft);
    const settled = isNaN(next)
      ? (emptyValue ?? (isFinite(min) ? min : 0))
      : clamp(round(next), min, max);
    if (settled !== value) onChange(settled);
    return format(settled);
  };

  return (
    <TextField
      {...textFieldProps}
      type="number"
      value={draft}
      error={error || draftInvalid}
      onChange={(e) => handleChange(e.target.value)}
      onFocus={(e) => {
        setFocused(true);
        setEdited(false);
        onFocus?.(e);
      }}
      onBlur={(e) => {
        setDraft(settle());
        setFocused(false);
        setEdited(false);
        onBlur?.(e);
      }}
      inputProps={{
        ...(isFinite(min) ? { min } : {}),
        ...(isFinite(max) ? { max } : {}),
        ...(step !== undefined ? { step } : {}),
        ...inputProps,
      }}
    />
  );
};

function format(value: number | undefined): string {
  return value === undefined ? "" : `${value}`;
}

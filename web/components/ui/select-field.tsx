import * as React from "react"
import { cn } from "cn"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.tsx"

/**
 * The desk's one dropdown: shadcn's Select with a native select's shape, so a list of
 * `<SelectOption value>label</SelectOption>` children is all a page writes. Every dashboard
 * dropdown goes through this (never a native `<select>`), so they all look and behave alike.
 */
type SelectFieldProps = {
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  disabled?: boolean
  size?: "sm" | "default"
  id?: string
  className?: string
  "aria-label"?: string
  children?: React.ReactNode
}

type SelectOptionProps = { value: string; disabled?: boolean; children?: React.ReactNode }

/** One choice in a `SelectField`. Renders nothing itself: the field reads its props. */
function SelectOption(_: SelectOptionProps): React.ReactNode {
  return null
}

function optionsOf(children: React.ReactNode, out: SelectOptionProps[] = []) {
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) return
    if (child.type === SelectOption) out.push(child.props as SelectOptionProps)
    else if (child.type === React.Fragment) optionsOf((child.props as { children?: React.ReactNode }).children, out)
  })
  return out
}

function SelectField({ value, defaultValue, onValueChange, disabled, size = "default", id, className, children, ...rest }: SelectFieldProps) {
  const options = optionsOf(children)
  return (
    <Select
      items={options.map((o) => ({ value: o.value, label: o.children }))}
      value={value}
      defaultValue={defaultValue}
      disabled={disabled}
      id={id}
      onValueChange={(v) => { if (typeof v === "string") onValueChange?.(v) }}
    >
      <SelectTrigger size={size} aria-label={rest["aria-label"]} className={cn("select-field", className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false} align="start" className="w-auto min-w-(--anchor-width) max-h-[min(var(--available-height),320px)]">
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} disabled={o.disabled}>
            {o.children}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export { SelectField, SelectOption }

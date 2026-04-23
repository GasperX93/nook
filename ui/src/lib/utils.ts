import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Standard shadcn `cn` helper — merge Tailwind classes safely so later utilities
 * win over earlier ones (`twMerge`) and conditional class objects collapse to a
 * single string (`clsx`). Imported by every shadcn primitive.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

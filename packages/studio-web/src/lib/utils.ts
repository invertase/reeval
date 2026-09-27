// Modified from shadcn/ui (https://ui.shadcn.com), MIT License, Copyright (c) 2023 shadcn.
import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

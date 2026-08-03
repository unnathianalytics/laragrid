<?php

declare(strict_types=1);

namespace LaraGrid\Columns;

/**
 * Focus modes for grid columns, mirroring ERP/voucher entry field behaviors (e.g. Busy Accounting):
 * - Always (Variable): Focuses on sequential keyboard navigation (Tab / Enter). Default.
 * - Manual (Semi-Variable): Skipped on sequential keyboard navigation, focusable on mouse click.
 * - Never (Fixed): Skipped on keyboard navigation, read-only / non-editable.
 */
enum FocusMode: string
{
    case Always = 'always';
    case Manual = 'manual';
    case Never = 'never';
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Landmark } from "lucide-react";
import { useLocale } from "next-intl";
import { LoanCard } from "./LoanCard";
import { PaginationControls } from "../ui/PaginationControls";
import type { BorrowerLoan } from "../../hooks/useApi";
import { EmptyState } from "../ui/EmptyState";
import { useWindowedList } from "../../hooks/useWindowedList";

interface LoanListProps {
  loans: BorrowerLoan[];
  variant?: "compact" | "detailed";
  emptyTitle?: string;
  emptyDescription?: string;
  /** Show "Request a Loan" CTA in the empty state. */
  showRequestLoanButton?: boolean;
  /**
   * Changing this value resets pagination and the virtualized scroll position
   * (e.g. pass the active filter key). Scroll position is otherwise preserved
   * across re-renders.
   */
  resetKey?: string;
}

const PAGE_SIZE = 20;
/** Above this many rows we window the list instead of paginating it. */
const VIRTUALIZATION_THRESHOLD = 50;
/** Rendered height of a single LoanCard row (incl. vertical gap), in px. */
const ROW_HEIGHT_COMPACT = 128;
const ROW_HEIGHT_DETAILED = 208;

export function LoanList({
  loans,
  variant = "compact",
  emptyTitle = "No Active Loans",
  emptyDescription = "You don't have any active loans at the moment.",
  showRequestLoanButton = false,
  resetKey,
}: LoanListProps) {
  const router = useRouter();
  const locale = useLocale();
  const [page, setPage] = useState(1);

  const shouldVirtualize = loans.length > VIRTUALIZATION_THRESHOLD;
  const rowHeight = variant === "detailed" ? ROW_HEIGHT_DETAILED : ROW_HEIGHT_COMPACT;

  const totalPages = Math.max(1, Math.ceil(loans.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const paginatedLoans = useMemo(
    () => loans.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [currentPage, loans],
  );

  const { startIndex, endIndex, totalHeight, offsetY, containerRef, scrollTo } = useWindowedList({
    itemCount: loans.length,
    itemHeight: rowHeight,
    overscan: 5,
    storageKey: "loan-list",
  });

  // Reset paging + scroll when the caller signals a filter/sort change.
  const previousResetKey = useRef(resetKey);
  useEffect(() => {
    if (previousResetKey.current !== resetKey) {
      previousResetKey.current = resetKey;
      setPage(1);
      scrollTo(0);
    }
  }, [resetKey, scrollTo]);

  if (loans.length === 0) {
    return (
      <EmptyState
        icon={Landmark}
        title={emptyTitle}
        description={emptyDescription}
        actionLabel={showRequestLoanButton ? "Request your first loan" : undefined}
        onAction={showRequestLoanButton ? () => router.push(`/${locale}/request-loan`) : undefined}
        actionIcon={<ArrowRight className="h-4 w-4" />}
      />
    );
  }

  if (shouldVirtualize) {
    const windowedLoans = loans.slice(startIndex, endIndex + 1);
    return (
      <div className="space-y-2">
        <div
          ref={containerRef}
          className="max-h-[70vh] overflow-y-auto pr-1"
          role="list"
          aria-label={`${loans.length} loans`}
        >
          <div style={{ height: totalHeight, position: "relative" }}>
            <div style={{ transform: `translateY(${offsetY}px)` }}>
              {windowedLoans.map((loan, i) => (
                <div
                  key={loan.id}
                  role="listitem"
                  aria-setsize={loans.length}
                  aria-posinset={startIndex + i + 1}
                  style={{ height: rowHeight }}
                  className="pb-4"
                >
                  <LoanCard loan={loan} variant={variant} />
                </div>
              ))}
            </div>
          </div>
        </div>
        <p className="text-sm text-zinc-500 dark:text-zinc-400" aria-live="polite">
          Showing {startIndex + 1}-{endIndex + 1} of {loans.length} loans
        </p>
        {/* Pagination fallback for environments without JS-driven scrolling. */}
        <noscript>
          <div className="space-y-4">
            {loans.slice(0, PAGE_SIZE).map((loan) => (
              <LoanCard key={loan.id} loan={loan} variant={variant} />
            ))}
          </div>
        </noscript>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {paginatedLoans.map((loan) => (
        <LoanCard key={loan.id} loan={loan} variant={variant} />
      ))}

      <PaginationControls
        currentPage={currentPage}
        totalPages={totalPages}
        hasPrevious={currentPage > 1}
        hasNext={currentPage < totalPages}
        onPageChange={setPage}
        onPrevious={() => setPage((previous) => Math.max(1, previous - 1))}
        onNext={() => setPage((previous) => Math.min(totalPages, previous + 1))}
        summary={`Showing ${(currentPage - 1) * PAGE_SIZE + 1}-${Math.min(
          currentPage * PAGE_SIZE,
          loans.length,
        )} of ${loans.length} loans`}
      />
    </div>
  );
}

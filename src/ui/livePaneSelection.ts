export function selectLivePaneIds(
  paneIds: string[],
  visiblePaneIds: string[],
  activePane: string,
  maxVisibleLivePanes: number,
): string[] {
  const paneIdSet = new Set(paneIds);
  const visibleOrdered = paneIds.filter((id) => paneIdSet.has(id) && visiblePaneIds.includes(id));
  if (visibleOrdered.length === 0) {
    return paneIds.includes(activePane) ? [activePane] : [];
  }

  const maxCount = Math.max(1, Math.min(maxVisibleLivePanes, visibleOrdered.length));
  if (maxCount >= visibleOrdered.length) return visibleOrdered;

  const activeIndex = visibleOrdered.indexOf(activePane);
  const pivotIndex =
    activeIndex >= 0
      ? activeIndex
      : visibleOrdered.reduce((bestIndex, id, index) => {
          const candidateDistance = Math.abs(paneIds.indexOf(id) - paneIds.indexOf(activePane));
          const bestDistance = Math.abs(paneIds.indexOf(visibleOrdered[bestIndex] ?? id) - paneIds.indexOf(activePane));
          return candidateDistance < bestDistance ? index : bestIndex;
        }, 0);

  const halfWindow = Math.floor(maxCount / 2);
  const start = Math.max(0, Math.min(visibleOrdered.length - maxCount, pivotIndex - halfWindow));
  return visibleOrdered.slice(start, start + maxCount);
}

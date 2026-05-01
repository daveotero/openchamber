import React from 'react';
import {
  RiRefreshLine,
  RiArrowDownLine,
  RiArrowUpLine,
  RiLoader4Line,
} from '@remixicon/react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { GitRemote } from '@/lib/gitApi';
import { useI18n } from '@/lib/i18n';

type SyncAction = 'fetch' | 'pull' | 'push' | null;

interface SyncActionsProps {
  syncAction: SyncAction;
  remotes: GitRemote[];
  fetchPullRemotes?: GitRemote[];
  onFetch: (remote: GitRemote) => void;
  onPull: (remote: GitRemote) => void;
  onPush: () => void;
  disabled: boolean;
  iconOnly?: boolean;
  tooltipDelayMs?: number;
  aheadCount?: number;
  behindCount?: number;
  trackingBranch?: string | null;
}

export const SyncActions: React.FC<SyncActionsProps> = ({
  syncAction,
  remotes = [],
  fetchPullRemotes,
  onFetch,
  onPull,
  onPush,
  disabled,
  iconOnly = false,
  tooltipDelayMs = 1000,
  aheadCount = 0,
  behindCount = 0,
  trackingBranch = null,
}) => {
  const { t } = useI18n();
  const syncRemotes = fetchPullRemotes ?? remotes;
  const hasNoRemotes = remotes.length === 0;
  const hasNoSyncRemotes = syncRemotes.length === 0;
  const isBaseDisabled = disabled || syncAction !== null;
  const isSyncDisabled = isBaseDisabled || hasNoSyncRemotes;
  const isPushDisabled = isBaseDisabled || hasNoRemotes;
  const trackingTarget = trackingBranch?.trim() ?? '';
  const fetchTooltip = trackingTarget
    ? t('gitView.sync.fetchTrackingTooltip', { tracking: trackingTarget })
    : t('gitView.sync.fetchTooltip');
  let pullTooltip = t('gitView.sync.pullTooltip');
  if (behindCount > 0) {
    pullTooltip = t('gitView.sync.pullTooltipBehind', { count: behindCount });
  }
  if (trackingTarget) {
    pullTooltip = behindCount > 0
      ? t('gitView.sync.pullTrackingTooltipBehind', { count: behindCount, tracking: trackingTarget })
      : t('gitView.sync.pullTrackingTooltip', { tracking: trackingTarget });
  }
  let pushTooltip = t('gitView.sync.pushTooltip');
  if (aheadCount > 0) {
    pushTooltip = t('gitView.sync.pushTooltipAhead', { count: aheadCount });
  }
  if (trackingTarget) {
    pushTooltip = aheadCount > 0
      ? t('gitView.sync.pushTrackingTooltipAhead', { count: aheadCount, tracking: trackingTarget })
      : t('gitView.sync.pushTrackingTooltip', { tracking: trackingTarget });
  }

  const handleFetch = () => {
    const remote = syncRemotes[0];
    if (remote) {
      onFetch(remote);
    }
  };

  const handlePull = () => {
    const remote = syncRemotes[0];
    if (remote) {
      onPull(remote);
    }
  };

  const handlePush = () => {
    if (remotes.length >= 1) {
      onPush();
    }
  };

  const renderButton = (
    action: SyncAction,
    icon: React.ReactNode,
    loadingIcon: React.ReactNode,
    label: string,
    onClick: () => void,
    tooltipText: string,
    counter?: number,
    buttonDisabled = isSyncDisabled
  ) => {
    const button = (
      <Button
        variant="ghost"
        size="sm"
        className={iconOnly ? 'relative h-8 w-8 px-0' : 'h-8 px-2'}
        onClick={onClick}
        disabled={buttonDisabled}
      >
        {syncAction === action ? loadingIcon : icon}
        {!iconOnly && <span className="git-header-label">{label}</span>}
        {!iconOnly && typeof counter === 'number' && counter > 0 ? (
          <span className="rounded-sm bg-interactive-selection/40 px-1 text-[10px] leading-4 text-foreground tabular-nums">
            {counter}
          </span>
        ) : null}
        {iconOnly && typeof counter === 'number' && counter > 0 ? (
          <span className="absolute -right-1 -top-1 min-w-[1rem] rounded-full bg-interactive-selection px-1 text-[10px] leading-4 text-interactive-selection-foreground tabular-nums">
            {counter}
          </span>
        ) : null}
      </Button>
    );

    return (
      <Tooltip delayDuration={tooltipDelayMs}>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent sideOffset={8}>{tooltipText}</TooltipContent>
      </Tooltip>
    );
  };

  return (
    <div className="flex items-center gap-0.5">
      {renderButton(
        'fetch',
        <RiRefreshLine className="size-4" />,
        <RiLoader4Line className="size-4 animate-spin" />,
        t('gitView.sync.fetch'),
        handleFetch,
        fetchTooltip,
        undefined,
        isSyncDisabled
      )}

      {renderButton(
        'pull',
        <RiArrowDownLine className="size-4" />,
        <RiLoader4Line className="size-4 animate-spin" />,
        t('gitView.sync.pull'),
        handlePull,
        pullTooltip,
        behindCount,
        isSyncDisabled
      )}

      {renderButton(
        'push',
        <RiArrowUpLine className="size-4" />,
        <RiLoader4Line className="size-4 animate-spin" />,
        t('gitView.sync.push'),
        handlePush,
        pushTooltip,
        aheadCount,
        isPushDisabled
      )}
    </div>
  );
};

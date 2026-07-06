import React, { useState, useEffect, useCallback } from 'react';
import {
  PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip,
  Legend, ResponsiveContainer,
} from 'recharts';
import {
  BarChart3, TrendingUp, Clock, Shield, RefreshCw,
  Activity, AlertTriangle, Cpu, Zap,
  ArrowRight,
} from 'lucide-react';
import { metricsApi } from '@/services/api';

interface DashboardMetrics {
  totalClaims: number;
  approvedClaims: number;
  deniedClaims: number;
  escalatedClaims: number;
  pendingClaims: number;
  avgProcessingTime: number;
  stpRate: number;
  agentInvocations: number;
  fraudDetected: number;
  statusBreakdown: Record<string, number>;
  recentClaims: RecentClaim[];
  costByComplexity: {
    simple: ComplexityTier;
    standard: ComplexityTier;
    complex: ComplexityTier;
  };
  aiAutoHandledPct: number;
  agentcoreMonthlyEst: number;
  agentcorePerClaim: number;
  totalAiCost: number;
  claimLeakage: number;
  claimCycleTime: number;
  escalatedCycleTime: number;
  touchesPerClaim: number;
  capacityScalability: number;
  systemLatency: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  avgTokensPerClaim: number;
  bedrockCost: number;
  agentcoreTotalCost: number;
}

interface RecentClaim {
  claimId: string;
  policyHolderName: string;
  policyNumber: string;
  claimAmount: number;
  status: string;
  submittedAt: string;
  aiInsights?: string;
  processingDetails?: {
    confidence?: number;
    fraudScore?: number;
  };
}

interface ComplexityTier {
  count: number;
  pct: number;
  totalPerClaim: number;
}

type TabId = 'overview' | 'operations' | 'analytics' | 'cost';

interface Tab {
  id: TabId;
  label: string;
  icon: React.ReactNode;
}

const TABS: Tab[] = [
  { id: 'overview', label: 'Overview', icon: <BarChart3 className="w-4 h-4" /> },
  { id: 'operations', label: 'Operations', icon: <Activity className="w-4 h-4" /> },
  { id: 'analytics', label: 'Analytics', icon: <TrendingUp className="w-4 h-4" /> },
  { id: 'cost', label: 'Cost & AI', icon: <Cpu className="w-4 h-4" /> },
];

const STATUS_COLORS: Record<string, string> = {
  approved: '#10b981',
  denied: '#ef4444',
  escalated: '#f59e0b',
  pending: '#6366f1',
  processing: '#3b82f6',
  submitted: '#8b5cf6',
};

// --- Utility Functions ---

function formatTime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}m ${secs}s`;
}

function formatDollars(amount: number): string {
  if (amount < 1) return `$${amount.toFixed(4)}`;
  if (amount < 100) return `$${amount.toFixed(2)}`;
  return `$${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return count.toString();
}

function formatTimeSince(dateStr: string): string {
  const now = new Date();
  const then = new Date(dateStr);
  const diffMs = now.getTime() - then.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function getStatusBadgeClasses(status: string): string {
  const base = 'px-2 py-0.5 rounded-full text-xs font-medium inline-block';
  switch (status.toLowerCase()) {
    case 'approved': return `${base} bg-emerald-100 text-emerald-700`;
    case 'denied': return `${base} bg-red-100 text-red-700`;
    case 'escalated': return `${base} bg-amber-100 text-amber-700`;
    case 'pending': return `${base} bg-indigo-100 text-indigo-700`;
    case 'processing': return `${base} bg-blue-100 text-blue-700`;
    case 'submitted': return `${base} bg-purple-100 text-purple-700`;
    default: return `${base} bg-gray-100 text-gray-700`;
  }
}

// --- Main Component ---

export default function BusinessDashboard() {
  const [activeTab, setActiveTab] = useState<TabId>('overview');
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
  const [isRefreshing, setIsRefreshing] = useState(false);

  const fetchMetrics = useCallback(async (silent = false) => {
    try {
      if (!silent) setLoading(true);
      setIsRefreshing(true);
      const data = await metricsApi.getDashboardMetrics();
      setMetrics(data as DashboardMetrics);
      setLastRefresh(new Date());
      setError(null);
    } catch (err) {
      setError('Failed to load dashboard metrics');
      console.error('Dashboard fetch error:', err);
    } finally {
      setLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchMetrics();
  }, [fetchMetrics]);

  // Auto-refresh for Operations tab
  useEffect(() => {
    if (activeTab !== 'operations') return;
    const interval = setInterval(() => fetchMetrics(true), 10000);
    return () => clearInterval(interval);
  }, [activeTab, fetchMetrics]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="flex flex-col items-center gap-3">
          <RefreshCw className="w-8 h-8 text-blue-500 animate-spin" />
          <p className="text-gray-500 text-sm">Loading dashboard...</p>
        </div>
      </div>
    );
  }

  if (error || !metrics) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-center">
          <AlertTriangle className="w-10 h-10 text-amber-500 mx-auto mb-3" />
          <p className="text-gray-700 font-medium">{error || 'No data available'}</p>
          <button
            onClick={() => fetchMetrics()}
            className="mt-3 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Business Dashboard</h1>
          <p className="text-sm text-gray-500 mt-1">
            Claims processing intelligence and operations
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-400">
            Last updated: {lastRefresh.toLocaleTimeString()}
          </span>
          <button
            onClick={() => fetchMetrics(true)}
            disabled={isRefreshing}
            className="p-2 rounded-lg hover:bg-gray-100 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 text-gray-600 ${isRefreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="flex gap-1 bg-gray-100 p-1 rounded-xl w-fit">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              activeTab === tab.id
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {activeTab === 'overview' && <OverviewTab metrics={metrics} />}
      {activeTab === 'operations' && <OperationsTab metrics={metrics} isRefreshing={isRefreshing} />}
      {activeTab === 'analytics' && <AnalyticsTab metrics={metrics} />}
      {activeTab === 'cost' && <CostTab metrics={metrics} />}
    </div>
  );
}

// --- Tab Components ---

function OverviewTab({ metrics }: { metrics: DashboardMetrics }) {
  const statusData = Object.entries(metrics.statusBreakdown).map(([name, value]) => ({
    name: name.charAt(0).toUpperCase() + name.slice(1),
    value,
    color: STATUS_COLORS[name.toLowerCase()] || '#9ca3af',
  }));

  const totalForBar = metrics.approvedClaims + metrics.deniedClaims + metrics.escalatedClaims + metrics.pendingClaims;

  return (
    <div className="space-y-6">
      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          title="Total Claims"
          value={metrics.totalClaims.toLocaleString()}
          icon={<BarChart3 className="w-5 h-5" />}
          bgColor="bg-blue-50"
          iconColor="text-blue-600"
          subtitle={`${metrics.pendingClaims} pending`}
        />
        <KpiCard
          title="STP Rate"
          value={`${metrics.stpRate.toFixed(1)}%`}
          icon={<TrendingUp className="w-5 h-5" />}
          bgColor="bg-emerald-50"
          iconColor="text-emerald-600"
          subtitle="Straight-through processing"
        />
        <KpiCard
          title="Avg Processing Time"
          value={formatTime(metrics.avgProcessingTime)}
          icon={<Clock className="w-5 h-5" />}
          bgColor="bg-amber-50"
          iconColor="text-amber-600"
          subtitle="End-to-end cycle"
        />
        <KpiCard
          title="Fraud Detected"
          value={metrics.fraudDetected.toLocaleString()}
          icon={<Shield className="w-5 h-5" />}
          bgColor="bg-red-50"
          iconColor="text-red-600"
          subtitle="Flagged claims"
        />
      </div>

      {/* Status Distribution & Bar */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Donut Chart */}
        <div className="card-flat rounded-xl p-6 shadow-sm">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">Status Distribution</h3>
          {statusData.length > 0 ? (
            <ResponsiveContainer width="100%" height={240}>
              <PieChart>
                <Pie
                  data={statusData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={90}
                  dataKey="value"
                  nameKey="name"
                  paddingAngle={2}
                >
                  {statusData.map((entry, idx) => (
                    <Cell key={`cell-${idx}`} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip formatter={(value: number) => value.toLocaleString()} />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-gray-400 text-sm text-center py-12">No data available</p>
          )}
        </div>

        {/* Stacked Status Bar */}
        <div className="card-flat rounded-xl p-6 shadow-sm">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">Claims Pipeline</h3>
          <div className="space-y-4">
            <div className="h-6 rounded-full overflow-hidden flex bg-gray-100">
              {totalForBar > 0 && (
                <>
                  <div
                    className="bg-emerald-500 transition-all"
                    style={{ width: `${(metrics.approvedClaims / totalForBar) * 100}%` }}
                    title={`Approved: ${metrics.approvedClaims}`}
                  />
                  <div
                    className="bg-red-500 transition-all"
                    style={{ width: `${(metrics.deniedClaims / totalForBar) * 100}%` }}
                    title={`Denied: ${metrics.deniedClaims}`}
                  />
                  <div
                    className="bg-amber-500 transition-all"
                    style={{ width: `${(metrics.escalatedClaims / totalForBar) * 100}%` }}
                    title={`Escalated: ${metrics.escalatedClaims}`}
                  />
                  <div
                    className="bg-indigo-500 transition-all"
                    style={{ width: `${(metrics.pendingClaims / totalForBar) * 100}%` }}
                    title={`Pending: ${metrics.pendingClaims}`}
                  />
                </>
              )}
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <StatusLegendItem color="bg-emerald-500" label="Approved" count={metrics.approvedClaims} />
              <StatusLegendItem color="bg-red-500" label="Denied" count={metrics.deniedClaims} />
              <StatusLegendItem color="bg-amber-500" label="Escalated" count={metrics.escalatedClaims} />
              <StatusLegendItem color="bg-indigo-500" label="Pending" count={metrics.pendingClaims} />
            </div>
          </div>
        </div>
      </div>

      {/* Claims Table */}
      <div className="card-flat rounded-xl p-6 shadow-sm">
        <h3 className="text-sm font-semibold text-gray-700 mb-4">Recent Claims</h3>
        {metrics.recentClaims.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="text-left py-2 px-3 text-gray-500 font-medium">Claim ID</th>
                  <th className="text-left py-2 px-3 text-gray-500 font-medium">Policy Holder</th>
                  <th className="text-right py-2 px-3 text-gray-500 font-medium">Amount</th>
                  <th className="text-center py-2 px-3 text-gray-500 font-medium">Status</th>
                  <th className="text-left py-2 px-3 text-gray-500 font-medium">AI Insights</th>
                </tr>
              </thead>
              <tbody>
                {metrics.recentClaims.slice(0, 10).map((claim) => (
                  <tr key={claim.claimId} className="border-b border-gray-50 hover:bg-gray-25">
                    <td className="py-2.5 px-3 font-mono text-xs text-gray-700">{claim.claimId}</td>
                    <td className="py-2.5 px-3 text-gray-700">{claim.policyHolderName}</td>
                    <td className="py-2.5 px-3 text-right text-gray-700">{formatDollars(claim.claimAmount)}</td>
                    <td className="py-2.5 px-3 text-center">
                      <span className={getStatusBadgeClasses(claim.status)}>{claim.status}</span>
                    </td>
                    <td className="py-2.5 px-3 text-gray-500 text-xs max-w-[200px] truncate">
                      {claim.aiInsights || '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-gray-400 text-sm text-center py-8">No recent claims</p>
        )}
      </div>
    </div>
  );
}

function OperationsTab({ metrics, isRefreshing }: { metrics: DashboardMetrics; isRefreshing: boolean }) {
  const processingNow = metrics.recentClaims.filter(
    (c) => c.status.toLowerCase() === 'submitted' || c.status.toLowerCase() === 'processing'
  ).length;

  const pipelineStages = [
    { label: 'Submitted', count: metrics.statusBreakdown['submitted'] || 0, color: 'bg-purple-500' },
    { label: 'Processing', count: metrics.statusBreakdown['processing'] || 0, color: 'bg-blue-500' },
    { label: 'Decision', count: (metrics.approvedClaims + metrics.deniedClaims + metrics.escalatedClaims), color: 'bg-emerald-500' },
  ];

  return (
    <div className="space-y-6">
      {/* Live Indicator */}
      <div className="flex items-center gap-2">
        <RefreshCw className={`w-4 h-4 text-emerald-500 ${isRefreshing ? 'animate-spin' : ''}`} />
        <span className="px-2 py-0.5 bg-emerald-100 text-emerald-700 text-xs font-medium rounded-full">
          Live
        </span>
        <span className="text-xs text-gray-400">Auto-refreshes every 10s</span>
      </div>

      {/* Operations KPIs */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <KpiCard
          title="Processing Now"
          value={processingNow.toString()}
          icon={<Activity className="w-5 h-5" />}
          bgColor="bg-blue-50"
          iconColor="text-blue-600"
          subtitle="Active claims"
        />
        <KpiCard
          title="Escalation Queue"
          value={metrics.escalatedClaims.toLocaleString()}
          icon={<AlertTriangle className="w-5 h-5" />}
          bgColor="bg-amber-50"
          iconColor="text-amber-600"
          subtitle="Awaiting review"
        />
        <KpiCard
          title="Avg Cycle Time"
          value={formatTime(metrics.claimCycleTime || metrics.avgProcessingTime)}
          icon={<Clock className="w-5 h-5" />}
          bgColor="bg-indigo-50"
          iconColor="text-indigo-600"
          subtitle="End-to-end"
        />
      </div>

      {/* Processing Pipeline */}
      <div className="card-flat rounded-xl p-6 shadow-sm">
        <h3 className="text-sm font-semibold text-gray-700 mb-4">Processing Pipeline</h3>
        <div className="flex items-center justify-between gap-2">
          {pipelineStages.map((stage, idx) => (
            <React.Fragment key={stage.label}>
              <div className="flex-1 text-center">
                <div className={`${stage.color} text-white rounded-lg py-3 px-4`}>
                  <div className="text-2xl font-bold">{stage.count}</div>
                  <div className="text-xs opacity-90">{stage.label}</div>
                </div>
              </div>
              {idx < pipelineStages.length - 1 && (
                <ArrowRight className="w-5 h-5 text-gray-300 flex-shrink-0" />
              )}
            </React.Fragment>
          ))}
        </div>
      </div>

      {/* Live Claims Feed */}
      <div className="card-flat rounded-xl p-6 shadow-sm">
        <h3 className="text-sm font-semibold text-gray-700 mb-4">Live Claims Feed</h3>
        {metrics.recentClaims.length > 0 ? (
          <div className="space-y-3">
            {metrics.recentClaims.slice(0, 10).map((claim) => (
              <div
                key={claim.claimId}
                className="flex items-center justify-between py-2 px-3 rounded-lg bg-gray-50 hover:bg-gray-100 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <span className="font-mono text-xs text-gray-600">{claim.claimId}</span>
                  <span className={getStatusBadgeClasses(claim.status)}>{claim.status}</span>
                </div>
                <div className="flex items-center gap-4">
                  <span className="text-sm font-medium text-gray-700">
                    {formatDollars(claim.claimAmount)}
                  </span>
                  <span className="text-xs text-gray-400">
                    {formatTimeSince(claim.submittedAt)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-gray-400 text-sm text-center py-8">No active claims</p>
        )}
      </div>
    </div>
  );
}

function AnalyticsTab({ metrics }: { metrics: DashboardMetrics }) {
  const decisionData = [
    { name: 'Approved', value: metrics.approvedClaims, color: '#10b981' },
    { name: 'Denied', value: metrics.deniedClaims, color: '#ef4444' },
    { name: 'Escalated', value: metrics.escalatedClaims, color: '#f59e0b' },
  ];

  const amountRanges = (() => {
    const ranges = [
      { name: '0-50K', min: 0, max: 50000, count: 0 },
      { name: '50-100K', min: 50000, max: 100000, count: 0 },
      { name: '100-250K', min: 100000, max: 250000, count: 0 },
      { name: '250K+', min: 250000, max: Infinity, count: 0 },
    ];
    metrics.recentClaims.forEach((claim) => {
      const range = ranges.find((r) => claim.claimAmount >= r.min && claim.claimAmount < r.max);
      if (range) range.count++;
    });
    return ranges;
  })();

  const fraudTotal = metrics.fraudDetected || 1;
  const fraudBreakdown = [
    { name: 'Low (<0.3)', value: Math.round(fraudTotal * 0.6), color: '#10b981' },
    { name: 'Medium (0.3-0.7)', value: Math.round(fraudTotal * 0.3), color: '#f59e0b' },
    { name: 'High (>0.7)', value: Math.max(1, fraudTotal - Math.round(fraudTotal * 0.6) - Math.round(fraudTotal * 0.3)), color: '#ef4444' },
  ];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Decision Distribution */}
        <div className="card-flat rounded-xl p-6 shadow-sm">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">Decision Distribution</h3>
          <ResponsiveContainer width="100%" height={240}>
            <PieChart>
              <Pie
                data={decisionData}
                cx="50%"
                cy="50%"
                outerRadius={80}
                dataKey="value"
                nameKey="name"
                label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
              >
                {decisionData.map((entry, idx) => (
                  <Cell key={`dec-${idx}`} fill={entry.color} />
                ))}
              </Pie>
              <Tooltip />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </div>

        {/* Claims by Amount Range */}
        <div className="card-flat rounded-xl p-6 shadow-sm">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">Claims by Amount Range</h3>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={amountRanges}>
              <XAxis dataKey="name" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 12 }} />
              <Tooltip />
              <Bar dataKey="count" fill="#6366f1" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Fraud Score Distribution */}
        <div className="card-flat rounded-xl p-6 shadow-sm">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">Fraud Score Distribution</h3>
          <div className="space-y-3">
            {fraudBreakdown.map((tier) => (
              <div key={tier.name} className="flex items-center gap-3">
                <div className="w-32 text-sm text-gray-600">{tier.name}</div>
                <div className="flex-1 h-6 bg-gray-100 rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      width: `${(tier.value / fraudTotal) * 100}%`,
                      backgroundColor: tier.color,
                    }}
                  />
                </div>
                <span className="text-sm font-medium text-gray-700 w-8">{tier.value}</span>
              </div>
            ))}
          </div>
        </div>

        {/* AI Confidence */}
        <div className="card-flat rounded-xl p-6 shadow-sm">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">AI Performance</h3>
          <div className="grid grid-cols-2 gap-4">
            <div className="text-center p-4 bg-purple-50 rounded-lg">
              <Zap className="w-6 h-6 text-purple-600 mx-auto mb-2" />
              <div className="text-2xl font-bold text-purple-700">
                {metrics.agentInvocations.toLocaleString()}
              </div>
              <div className="text-xs text-purple-600">Agent Invocations</div>
            </div>
            <div className="text-center p-4 bg-blue-50 rounded-lg">
              <TrendingUp className="w-6 h-6 text-blue-600 mx-auto mb-2" />
              <div className="text-2xl font-bold text-blue-700">
                {metrics.stpRate.toFixed(1)}%
              </div>
              <div className="text-xs text-blue-600">Auto-Resolution Rate</div>
            </div>
            <div className="text-center p-4 bg-emerald-50 rounded-lg">
              <Shield className="w-6 h-6 text-emerald-600 mx-auto mb-2" />
              <div className="text-2xl font-bold text-emerald-700">
                {metrics.touchesPerClaim?.toFixed(1) || 'N/A'}
              </div>
              <div className="text-xs text-emerald-600">Touches per Claim</div>
            </div>
            <div className="text-center p-4 bg-amber-50 rounded-lg">
              <Clock className="w-6 h-6 text-amber-600 mx-auto mb-2" />
              <div className="text-2xl font-bold text-amber-700">
                {metrics.systemLatency ? `${metrics.systemLatency.toFixed(0)}ms` : 'N/A'}
              </div>
              <div className="text-xs text-amber-600">System Latency</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function CostTab({ metrics }: { metrics: DashboardMetrics }) {
  const manualCostPerClaim = 25;
  const aiCostPerClaim = metrics.agentcorePerClaim || (metrics.totalAiCost / Math.max(metrics.totalClaims, 1));
  const savingsPerClaim = manualCostPerClaim - aiCostPerClaim;
  const savingsPct = ((savingsPerClaim / manualCostPerClaim) * 100).toFixed(1);

  const tokenData = [
    { name: 'Input Tokens', value: metrics.inputTokens },
    { name: 'Output Tokens', value: metrics.outputTokens },
  ];

  const complexityTiers = [
    { label: 'Simple', data: metrics.costByComplexity?.simple, color: 'emerald' },
    { label: 'Standard', data: metrics.costByComplexity?.standard, color: 'blue' },
    { label: 'Complex', data: metrics.costByComplexity?.complex, color: 'amber' },
  ];

  return (
    <div className="space-y-6">
      {/* Cost Comparison */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="card-flat rounded-xl p-6 shadow-sm border-l-4 border-l-red-400">
          <div className="text-sm text-gray-500">Traditional Manual Cost</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">{formatDollars(manualCostPerClaim)}</div>
          <div className="text-xs text-gray-400 mt-1">per claim (industry average)</div>
        </div>
        <div className="card-flat rounded-xl p-6 shadow-sm border-l-4 border-l-emerald-400">
          <div className="text-sm text-gray-500">AI Cost per Claim</div>
          <div className="text-2xl font-bold text-emerald-700 mt-1">{formatDollars(aiCostPerClaim)}</div>
          <div className="text-xs text-gray-400 mt-1">Bedrock + AgentCore</div>
        </div>
        <div className="card-flat rounded-xl p-6 shadow-sm border-l-4 border-l-purple-400">
          <div className="text-sm text-gray-500">Savings per Claim</div>
          <div className="text-2xl font-bold text-purple-700 mt-1">{formatDollars(savingsPerClaim)}</div>
          <div className="text-xs text-emerald-600 mt-1">{savingsPct}% reduction</div>
        </div>
      </div>

      {/* Complexity Tiers */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {complexityTiers.map((tier) => (
          <div key={tier.label} className="card-flat rounded-xl p-6 shadow-sm">
            <h4 className="text-sm font-semibold text-gray-700 mb-3">{tier.label} Claims</h4>
            {tier.data ? (
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">Count</span>
                  <span className="font-medium">{tier.data.count}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">Percentage</span>
                  <span className="font-medium">{tier.data.pct.toFixed(1)}%</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">Cost per Claim</span>
                  <span className="font-medium">{formatDollars(tier.data.totalPerClaim)}</span>
                </div>
              </div>
            ) : (
              <p className="text-gray-400 text-sm">No data</p>
            )}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Token Usage */}
        <div className="card-flat rounded-xl p-6 shadow-sm">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">Token Usage</h3>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={tokenData}>
              <XAxis dataKey="name" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 12 }} tickFormatter={(v) => formatTokens(v)} />
              <Tooltip formatter={(value: number) => formatTokens(value)} />
              <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                <Cell fill="#8b5cf6" />
                <Cell fill="#6366f1" />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <div className="mt-3 text-center text-sm text-gray-500">
            Total: {formatTokens(metrics.totalTokens)} | Avg per claim: {formatTokens(metrics.avgTokensPerClaim)}
          </div>
        </div>

        {/* Cost Breakdown & ROI */}
        <div className="card-flat rounded-xl p-6 shadow-sm">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">Cost Breakdown</h3>
          <div className="space-y-4">
            <div className="flex justify-between items-center py-2 border-b border-gray-100">
              <span className="text-sm text-gray-600">Bedrock Cost</span>
              <span className="text-sm font-medium">{formatDollars(metrics.bedrockCost)}</span>
            </div>
            <div className="flex justify-between items-center py-2 border-b border-gray-100">
              <span className="text-sm text-gray-600">AgentCore Cost</span>
              <span className="text-sm font-medium">{formatDollars(metrics.agentcoreTotalCost)}</span>
            </div>
            <div className="flex justify-between items-center py-2 border-b border-gray-100">
              <span className="text-sm text-gray-600">Total AI Cost</span>
              <span className="text-sm font-bold">{formatDollars(metrics.totalAiCost)}</span>
            </div>
          </div>

          {/* ROI Highlight */}
          <div className="mt-6 p-4 bg-purple-50 rounded-lg">
            <div className="flex items-center gap-2 mb-1">
              <Cpu className="w-4 h-4 text-purple-600" />
              <span className="text-sm font-semibold text-purple-700">AI Automation ROI</span>
            </div>
            <p className="text-sm text-purple-600">
              AI handles <span className="font-bold">{metrics.aiAutoHandledPct?.toFixed(1) || 0}%</span> of claims without human intervention
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Shared Sub-Components ---

interface KpiCardProps {
  title: string;
  value: string;
  icon: React.ReactNode;
  bgColor: string;
  iconColor: string;
  subtitle?: string;
}

function KpiCard({ title, value, icon, bgColor, iconColor, subtitle }: KpiCardProps) {
  return (
    <div className="card-flat rounded-xl p-5 shadow-sm">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-gray-500">{title}</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{value}</p>
          {subtitle && <p className="text-xs text-gray-400 mt-1">{subtitle}</p>}
        </div>
        <div className={`${bgColor} ${iconColor} p-2.5 rounded-lg`}>
          {icon}
        </div>
      </div>
    </div>
  );
}

function StatusLegendItem({ color, label, count }: { color: string; label: string; count: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className={`w-3 h-3 rounded-full ${color}`} />
      <span className="text-gray-600">{label}</span>
      <span className="font-medium text-gray-900 ml-auto">{count}</span>
    </div>
  );
}

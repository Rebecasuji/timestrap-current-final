import { useState, useEffect } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { useAuth } from '@/context/AuthContext';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { apiRequest, queryClient } from '@/lib/queryClient';
import { CheckCircle2, Circle, ArrowRight, ArrowLeft, Send, AlertTriangle, Clock, Calendar as CalendarIcon, ClipboardList, Target, Power, PowerOff, Lock, Search as PlannedTaskSearchIcon } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { format, addDays } from 'date-fns';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';

export default function PlanForDayPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [selectedTasks, setSelectedTasks] = useState<any[]>([]);
  const [commonReason, setCommonReason] = useState("");
  const [commonNewDueDate, setCommonNewDueDate] = useState(format(addDays(new Date(), 1), 'yyyy-MM-dd'));
  const [showUnselectedForm, setShowUnselectedForm] = useState(false);
  const [activeTab, setActiveTab] = useState<'plan' | 'history'>('plan');
  const [historyDate, setHistoryDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [assignedTaskSearch, setAssignedTaskSearch] = useState("");
  const [plannedTaskSearch, setPlannedTaskSearch] = useState("");
  const [currentTime, setCurrentTime] = useState(new Date());
  const [serverTimeOffset, setServerTimeOffset] = useState(0);

  const today = format(new Date(), 'yyyy-MM-dd');
  const isController = user?.employeeCode === 'E0046';

  // Fetch plan window status from server
  const { data: windowData, refetch: refetchWindowStatus } = useQuery({
    queryKey: ['/api/plan-window'],
    queryFn: async () => {
      const res = await fetch('/api/plan-window');
      return res.json();
    },
    refetchInterval: 30000, // poll every 30s
  });

  // Check if plan already submitted
  const { data: planStatus, isLoading: isLoadingPlan } = useQuery({
    queryKey: ['/api/daily-plans/today', user?.id],
    enabled: !!user?.id,
    queryFn: async () => {
      const res = await fetch(`/api/daily-plans/today/${user?.id}`);
      if (!res.ok) return { submitted: false };
      return res.json();
    }
  });

  // Fetch plan history for a specific date
  const { data: historyData, isLoading: isLoadingHistory } = useQuery({
    queryKey: ['/api/daily-plans', historyDate, user?.id],
    enabled: !!user?.id && !!historyDate,
    queryFn: async () => {
      const res = await fetch(`/api/daily-plans/${historyDate}/${user?.id}`);
      if (!res.ok) return { submitted: false };
      return res.json();
    }
  });

  // Fetch available tasks from PMS
  const { data: availableTasks = [], isLoading: isLoadingTasks } = useQuery({
    queryKey: ['/api/available-tasks', user?.id],
    enabled: !!user?.id,
    queryFn: async () => {
      const res = await fetch(`/api/available-tasks?employeeId=${user?.id}`);
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    }
  });

  // Window and Cutoff computations
  const isWindowOpen = !!windowData?.planWindowOpen;
  const isPastCutoff = !!windowData?.isPastCutoff;
  const isAlreadySubmittedAndBlocked = planStatus?.submitted;
  const isWindowClosedNotSubmitted = (!isWindowOpen || isPastCutoff) && !planStatus?.submitted;

  useEffect(() => {
    if (windowData?.serverTime) {
      const serverDate = new Date(windowData.serverTime);
      const localDate = new Date();
      setServerTimeOffset(serverDate.getTime() - localDate.getTime());
    }
  }, [windowData?.serverTime]);

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Pre-fill selected tasks from existing plan OR auto-synced tasks
  useEffect(() => {
    if (availableTasks.length > 0) {
      if (planStatus?.submitted && planStatus.tasks && selectedTasks.length === 0) {
        // Plan already exists, use those tasks
        const currentlyPlannedIds = new Set(planStatus.tasks.map((t: any) => t.taskId));
        const initialSelection = availableTasks.filter((t: any) => currentlyPlannedIds.has(t.id) || t.isAutoSelected);
        setSelectedTasks(initialSelection);
      } else if (!planStatus?.submitted && selectedTasks.length === 0) {
        // New plan, auto-select PMS scheduled tasks
        const autoTasks = availableTasks.filter((t: any) => t.isAutoSelected);
        if (autoTasks.length > 0) {
          setSelectedTasks(autoTasks);
        }
      }
    }
  }, [planStatus, availableTasks]);

  const toggleWindowMutation = useMutation({
    mutationFn: async (open: boolean) => {
      const res = await apiRequest('PATCH', '/api/plan-window', { employeeId: user?.id, open });
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.setQueryData(['/api/plan-window'], data);
      toast({
        title: data.planWindowOpen ? '🟢 Plan Window Opened' : '🔴 Plan Window Closed',
        description: data.planWindowOpen ? 'Employees can submit plans.' : 'Submission restricted.',
      });
    }
  });

  const sendReminderMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest('POST', '/api/daily-plans/reminder', { employeeId: user?.id });
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: '✅ Alert Emails Sent', description: `Sent ${data.count} alerts.` });
    }
  });

  const sendEODReportMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest('POST', '/api/admin/check-missing-submissions', { actorId: user?.id });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: '📊 EOD Report Sent', description: 'Report sent to admins.' });
    }
  });

  const submitPlanMutation = useMutation({
    mutationFn: async (payload: any) => {
      const res = await apiRequest('POST', '/api/daily-plans', payload);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/daily-plans/today', user?.id] });
      toast({ title: "Success", description: "Your Plan for the Day has been submitted!" });
      setLocation('/tracker');
    },
    onError: (err: any) => {
      toast({ title: "Submission Failed", description: err.message || "Failed to submit plan.", variant: "destructive" });
    }
  });

  const filteredAvailableTasks = availableTasks.filter((task: any) => 
    (task.task_name.toLowerCase().includes(assignedTaskSearch.toLowerCase()) ||
    task.projectName.toLowerCase().includes(assignedTaskSearch.toLowerCase())) &&
    !task.isAutoSelected 
  );

  const filteredSelectedTasks = selectedTasks.filter((task: any) => 
    task.task_name.toLowerCase().includes(plannedTaskSearch.toLowerCase()) ||
    task.projectName.toLowerCase().includes(plannedTaskSearch.toLowerCase())
  );

  if (isLoadingPlan || isLoadingTasks) {
    return (
      <div className="flex flex-col h-screen items-center justify-center bg-slate-950 text-white gap-4">
        <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
        <p className="text-slate-400 font-medium">Checking your schedule...</p>
      </div>
    );
  }

  const toggleTask = (task: any) => {
    if (task.isLocked) {
      toast({
        title: "Task Locked",
        description: "This is a PMS scheduled task and cannot be removed.",
      });
      return;
    }
    if (selectedTasks.find(t => t.id === task.id)) {
      setSelectedTasks(selectedTasks.filter(t => t.id !== task.id));
    } else {
      setSelectedTasks([...selectedTasks, task]);
    }
  };

  const handleNext = () => {
    if (selectedTasks.length === 0) {
      toast({ title: "Selection Required", description: "Please select at least one task for your plan.", variant: "destructive" });
      return;
    }
    const unselected = availableTasks.filter((t: any) => !selectedTasks.find((st: any) => st.id === t.id));
    if (unselected.length > 0) {
      setShowUnselectedForm(true);
      setCommonReason("");
      setCommonNewDueDate(format(addDays(new Date(), 1), 'yyyy-MM-dd'));
    } else {
      submitPlan();
    }
  };

  const submitPlan = () => {
    if (!isWindowOpen || isPastCutoff) {
      toast({ title: "Submission Blocked", description: "The plan window is closed.", variant: "destructive" });
      return;
    }
    const unselected = availableTasks.filter((t: any) => !selectedTasks.find((st: any) => st.id === t.id))
      .map((t: any) => ({
        taskId: t.id,
        taskName: t.task_name,
        reason: commonReason,
        newDueDate: commonNewDueDate,
        start_date: t.start_date,
        end_date: t.end_date,
        progress: t.progress,
        isOverdue: t.isOverdue
      }));

    if (showUnselectedForm && (!commonReason || !commonNewDueDate)) {
      toast({ title: "Missing Information", description: "Please provide a reason and new due date.", variant: "destructive" });
      return;
    }

    submitPlanMutation.mutate({
      employeeId: user?.id,
      date: today,
      selectedTasks: selectedTasks,
      unselectedTasks: unselected
    });
  };

  const getMinutesUntilCutoff = () => {
    const nowOnServer = new Date(currentTime.getTime() + serverTimeOffset);
    const cutoff = new Date(nowOnServer);
    cutoff.setHours(12, 30, 0, 0);
    const diff = cutoff.getTime() - nowOnServer.getTime();
    return Math.floor(diff / 60000);
  };

  const minutesUntilCutoff = getMinutesUntilCutoff();
  const isNearCutoff = minutesUntilCutoff > 0 && minutesUntilCutoff <= 30;

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6 bg-slate-950 min-h-screen text-white">
      <header className="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-2">
        <div>
          <h1 className="text-3xl font-black tracking-tight flex items-center gap-3">
            <ClipboardList className="w-8 h-8 text-blue-500" />
            PLAN FOR THE DAY
          </h1>
          <p className="text-slate-400 font-medium">Capture your objectives and manage deviations</p>
        </div>

        <div className="flex items-center gap-4">
           <div className="bg-slate-900/80 p-1.5 rounded-2xl flex items-center border border-slate-800 shadow-lg">
             <button 
                onClick={() => setActiveTab('plan')}
                className={`px-6 py-2.5 rounded-xl text-xs font-black uppercase tracking-widest transition-all ${
                  activeTab === 'plan' ? 'bg-blue-600 text-white' : 'text-slate-500'
                }`}
             >
                Daily Plan
             </button>
             <button 
                onClick={() => setActiveTab('history')}
                className={`px-6 py-2.5 rounded-xl text-xs font-black uppercase tracking-widest transition-all ${
                  activeTab === 'history' ? 'bg-indigo-600 text-white' : 'text-slate-500'
                }`}
             >
                History
             </button>
           </div>

          <div className={`hidden lg:flex items-center gap-3 px-6 py-3 rounded-2xl border ${isWindowOpen && !isPastCutoff ? 'bg-green-500/10 border-green-500/30' : 'bg-red-500/10 border-red-500/30'} backdrop-blur-sm`}>
            <Clock className={`w-4 h-4 ${isWindowOpen && !isPastCutoff ? 'text-green-400' : 'text-red-400'}`} />
            <span className={`text-[10px] font-bold uppercase tracking-wider ${isWindowOpen && !isPastCutoff ? 'text-green-400' : 'text-red-400'}`}>
              {isWindowOpen && !isPastCutoff ? 'Open' : isPastCutoff ? 'Cutoff Reached' : 'Closed'}
            </span>
          </div>

          {(user?.employeeCode === 'E0046' || user?.employeeCode === 'E0048') && (
            <div className="flex items-center gap-2">
              <Button onClick={() => sendReminderMutation.mutate()} variant="outline" className="rounded-xl font-bold text-xs">Alert</Button>
              <Button onClick={() => sendEODReportMutation.mutate()} variant="outline" className="rounded-xl font-bold text-xs">EOD Report</Button>
            </div>
          )}

          {isController && (
            <Button
              onClick={() => toggleWindowMutation.mutate(!isWindowOpen)}
              size="sm"
              className={`rounded-xl font-black text-xs px-4 py-5 ${isWindowOpen ? 'bg-red-600/80' : 'bg-green-600'}`}
            >
              {isWindowOpen ? <PowerOff className="w-4 h-4" /> : <Power className="w-4 h-4" />}
            </Button>
          )}
        </div>
      </header>

      {activeTab === 'history' ? (
        <HistorySection historyDate={historyDate} setHistoryDate={setHistoryDate} isLoadingHistory={isLoadingHistory} historyData={historyData} today={today} />
      ) : isAlreadySubmittedAndBlocked ? (
        <div className="flex flex-col h-[calc(100vh-250px)] items-center justify-center p-8 text-center">
          <div className="bg-slate-900/50 p-12 rounded-3xl border border-blue-500/20 max-w-lg w-full">
            <CheckCircle2 className="w-12 h-12 text-green-500 mx-auto mb-8" />
            <h1 className="text-3xl font-extrabold mb-4">Today's Plan Ready!</h1>
            <p className="text-slate-400 mb-8">You've already locked in your tasks for today.</p>
            <div className="flex gap-4 justify-center">
              <Button onClick={() => setLocation('/tracker')} className="px-8 bg-blue-600">Go to Tracker</Button>
              <Button onClick={() => setActiveTab('history')} variant="outline" className="px-8">View Plan</Button>
            </div>
          </div>
        </div>
      ) : isWindowClosedNotSubmitted ? (
        <div className="flex flex-col h-[calc(100vh-250px)] items-center justify-center p-8 text-center">
          <div className="bg-slate-900/50 p-12 rounded-3xl border border-red-500/20 max-w-lg w-full">
            <PowerOff className="w-12 h-12 text-red-500 mx-auto mb-8" />
            <h1 className="text-3xl font-extrabold mb-4">Plan Window Closed</h1>
            <p className="text-slate-400 mb-8">{isPastCutoff ? "Closed (12:30 PM cutoff)" : "Currently closed by administrator."}</p>
            <Button onClick={() => setLocation('/tracker')} className="px-8 bg-slate-700">Go to Tracker</Button>
          </div>
        </div>
      ) : !showUnselectedForm ? (
        <div className="space-y-6">
          {isNearCutoff && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} className="bg-amber-500/10 border border-amber-500/30 rounded-2xl p-4 flex items-center gap-4 text-amber-400">
              <Clock className="w-6 h-6 animate-pulse" />
              <div>
                <p className="font-black text-sm uppercase">Plan Window Closing Soon!</p>
                <p className="text-xs opacity-80">{minutesUntilCutoff} minutes remaining.</p>
              </div>
            </motion.div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 h-[calc(100vh-450px)] min-h-[500px]">
            <Card className="bg-slate-900/60 border-slate-800 flex flex-col h-full overflow-hidden shadow-xl">
              <CardHeader className="border-b border-slate-800/50 pb-4">
                <CardTitle className="text-xl flex items-center gap-3 text-slate-200">
                  <Target className="w-5 h-5 text-slate-400" /> Available Tasks
                </CardTitle>
                <div className="mt-3 relative">
                  <PlannedTaskSearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                  <Input placeholder="Search tasks..." value={assignedTaskSearch} onChange={(e) => setAssignedTaskSearch(e.target.value)} className="bg-slate-950/50 border-slate-800 pl-10" />
                </div>
              </CardHeader>
              <ScrollArea className="flex-1 p-4">
                <div className="space-y-3">
                  {filteredAvailableTasks.map((task: any) => {
                    const isSelected = selectedTasks.find(t => t.id === task.id);
                    return (
                      <motion.div
                        key={task.id}
                        className={`p-5 rounded-2xl border cursor-pointer flex items-center gap-4 ${isSelected ? 'bg-blue-600/20 border-blue-500/50' : 'bg-slate-800/40 border-slate-700/50'}`}
                        onClick={() => toggleTask(task)}
                      >
                        <div className={`w-10 h-10 rounded-xl flex items-center justify-center border ${isSelected ? 'bg-blue-500 border-blue-400 text-white' : 'bg-slate-900 border-slate-800 text-slate-700'}`}>
                          {isSelected ? <CheckCircle2 className="w-6 h-6" /> : <Circle className="w-6 h-6" />}
                        </div>
                        <div>
                          <h3 className="font-bold text-slate-100">{task.task_name}</h3>
                          <p className="text-xs text-slate-500 font-bold uppercase">{task.projectName}</p>
                        </div>
                      </motion.div>
                    );
                  })}
                </div>
              </ScrollArea>
            </Card>

            <Card className="bg-slate-900/60 border-blue-500/10 flex flex-col h-full overflow-hidden shadow-xl">
              <CardHeader className="bg-blue-500/5 border-b border-blue-500/10 pb-4">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-xl flex items-center gap-3 text-blue-400 font-black">YOUR PLAN</CardTitle>
                  <div className="bg-blue-500/20 px-3 py-1 rounded-full border border-blue-500/30">
                    <span className="text-xs font-black text-blue-400">{selectedTasks.length} SELECTED</span>
                  </div>
                </div>
                <div className="mt-3 relative">
                  <PlannedTaskSearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-blue-500/50" />
                  <Input placeholder="Search your plan..." value={plannedTaskSearch} onChange={(e) => setPlannedTaskSearch(e.target.value)} className="bg-slate-950/50 border-blue-500/20 pl-10" />
                </div>
              </CardHeader>
              <ScrollArea className="flex-1 p-4">
                <div className="space-y-4">
                  {selectedTasks.some(t => t.isAutoSelected) && (
                    <div className="space-y-2">
                       <div className="flex items-center gap-2 px-1 text-[10px] font-black text-amber-500 uppercase tracking-widest"><Lock className="w-3 h-3" /> PMS Tasks (Auto)</div>
                       {selectedTasks.filter(t => t.isAutoSelected).map(task => (
                          <div key={task.id} className="p-4 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-between">
                             <div><h4 className="font-black text-amber-100">{task.task_name}</h4><p className="text-[10px] text-amber-500/60 font-bold uppercase">{task.projectName}</p></div>
                             <Lock className="w-4 h-4 text-amber-500/40" />
                          </div>
                       ))}
                    </div>
                  )}
                  {selectedTasks.some(t => !t.isAutoSelected) && (
                    <div className="space-y-2 pt-2">
                       <div className="flex items-center gap-2 px-1 text-[10px] font-black text-blue-500 uppercase tracking-widest"><ClipboardList className="w-3 h-3" /> Manual Tasks</div>
                       {selectedTasks.filter(t => !t.isAutoSelected).map(task => (
                          <div key={task.id} className="p-4 rounded-2xl bg-blue-600/10 border border-blue-500/20 flex items-center justify-between">
                             <div><h4 className="font-black text-blue-100">{task.task_name}</h4><p className="text-[10px] text-blue-400/60 font-bold uppercase">{task.projectName}</p></div>
                             <Button variant="ghost" size="sm" onClick={() => toggleTask(task)} className="text-slate-500 hover:text-red-400 hover:bg-red-400/10 rounded-xl">Cancel</Button>
                          </div>
                       ))}
                    </div>
                  )}
                </div>
              </ScrollArea>
              <div className="p-6 bg-slate-900/50 border-t border-slate-800 space-y-4">
                 <div className="flex items-center gap-2 text-xs text-slate-500 font-bold px-1"><AlertTriangle className="w-4 h-4 text-amber-500" /> TASKS MUST BE COMPLETED TODAY.</div>
                 <Button className="w-full py-7 bg-gradient-to-r from-blue-600 to-indigo-600 text-white font-black text-lg rounded-2xl" disabled={selectedTasks.length === 0 || !isWindowOpen || isPastCutoff} onClick={handleNext}>LOCK IN MY PLAN <ArrowRight className="w-6 h-6 ml-3" /></Button>
              </div>
            </Card>
          </div>
        </div>
      ) : (
        <motion.div initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className="max-w-4xl mx-auto">
          <Card className="bg-slate-900/80 border-amber-500/20 backdrop-blur-xl">
            <CardHeader className="bg-amber-500/5 border-b border-amber-500/10 p-6">
              <div className="flex items-center gap-4">
                 <div className="w-12 h-12 bg-amber-500/20 rounded-2xl flex items-center justify-center border border-amber-500/30"><AlertTriangle className="w-6 h-6 text-amber-500" /></div>
                 <div><CardTitle className="text-2xl font-black text-white">Controlled Deviation Required</CardTitle><p className="text-amber-500/80 font-bold text-sm uppercase">Unselected tasks require justification</p></div>
              </div>
            </CardHeader>
            <CardContent className="p-8 space-y-8">
              <div className="p-8 rounded-3xl bg-slate-800/30 border border-slate-700/50 space-y-8">
                <div>
                  <Label className="text-slate-400 font-bold text-xs uppercase mb-4 block">Pending Tasks Being Postponed</Label>
                  <div className="flex flex-wrap gap-2">
                     {availableTasks.filter((t: any) => !selectedTasks.find((st: any) => st.id === t.id)).map((task: any) => (
                       <div key={task.id} className="px-4 py-2 rounded-xl bg-slate-900 border border-slate-700 text-slate-300 text-sm font-bold flex items-center gap-2"><Clock className="w-4 h-4 text-amber-500/50" /> {task.task_name}</div>
                     ))}
                  </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                  <div className="space-y-3">
                    <Label className="text-slate-400 font-bold text-xs uppercase">Reason for Deviation *</Label>
                    <Textarea placeholder="Justification..." value={commonReason} onChange={(e) => setCommonReason(e.target.value)} className="bg-slate-900 border-slate-700 text-white min-h-[120px]" />
                  </div>
                  <div className="space-y-3">
                    <Label className="text-slate-400 font-bold text-xs uppercase">New Target Due Date *</Label>
                    <Input type="date" value={commonNewDueDate} min={today} onChange={(e) => setCommonNewDueDate(e.target.value)} className="bg-slate-950 border-slate-800 h-16 text-lg" />
                  </div>
                </div>
              </div>
              <div className="flex gap-4 pt-4">
                <Button variant="outline" onClick={() => setShowUnselectedForm(false)} className="px-8 py-6 rounded-2xl"><ArrowLeft className="w-5 h-5 mr-2" /> Back</Button>
                <Button onClick={submitPlan} className="flex-1 py-6 bg-gradient-to-r from-amber-600 to-orange-600 text-white font-black text-lg rounded-2xl" disabled={submitPlanMutation.isPending}>SUBMIT PLAN <Send className="w-6 h-6 ml-3" /></Button>
              </div>
            </CardContent>
          </Card>
        </motion.div>
      )}
    </div>
  );
}

function HistorySection({ historyDate, setHistoryDate, isLoadingHistory, historyData, today }: any) {
  return (
    <div className="space-y-8">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-2xl font-black flex items-center gap-3"><CalendarIcon className="w-6 h-6 text-green-500" /> PLAN HISTORY</h2>
        <div className="bg-slate-900 p-2 rounded-2xl border border-slate-800 flex items-center">
          <CalendarIcon className="w-4 h-4 text-green-500 mx-3" />
          <Input type="date" value={historyDate} max={today} onChange={(e) => setHistoryDate(e.target.value)} className="bg-slate-950 border-none h-10 w-48 text-sm" />
        </div>
      </div>
      {isLoadingHistory ? <div className="py-20 text-center"><div className="w-10 h-10 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" /><p className="text-slate-500 font-bold uppercase text-xs">Loading...</p></div> : 
       historyData?.submitted ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <Card className="bg-slate-900 border-slate-800 p-6"><h4 className="text-green-400 font-black mb-4 flex items-center gap-2"><CheckCircle2 className="w-5 h-5" /> SELECTED</h4><div className="space-y-3">{historyData.tasks.map((t: any) => (<div key={t.id} className="p-4 rounded-xl bg-slate-800/50 border border-slate-700/50"><h4 className="font-bold text-slate-100">{t.taskName}</h4><p className="text-xs text-slate-400 uppercase font-bold">{t.projectName}</p></div>))}</div></Card>
          <Card className="bg-slate-900 border-slate-800 p-6"><h4 className="text-amber-400 font-black mb-4 flex items-center gap-2"><Clock className="w-5 h-5" /> NOT SELECTED</h4><div className="space-y-3">{historyData.postponedTasks.length === 0 ? <p className="text-slate-500 italic">None</p> : historyData.postponedTasks.map((t: any, idx: number) => (<div key={idx} className="p-4 rounded-xl bg-amber-500/5 border border-amber-500/10"><h4 className="font-bold text-amber-100">{t.task_name}</h4><p className="text-sm text-slate-300 italic">{t.reason}</p><p className="text-[10px] text-amber-500/60 uppercase mt-2">Next: {t.new_due_date}</p></div>))}</div></Card>
        </div>
      ) : <div className="py-24 text-center bg-slate-900/50 rounded-3xl border border-slate-800 border-dashed"><p className="text-slate-500 font-bold text-lg">No plan submitted for this date.</p></div>}
    </div>
  );
}
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { LogOut, Menu, Calendar } from 'lucide-react';
import { User, UserRole } from '@/context/AuthContext';
import logoImage from '@assets/WhatsApp_Image_2025-11-11_at_11.06.02_AM_1765464690595.jpeg';
import AlertsPopover from './AlertsPopover';

interface AppHeaderProps {
  user: User;
  onLogout: () => void;
  onMenuClick?: () => void;
  onToggleSidebar?: () => void;
  selectedDate?: Date;
  onDateChange?: (date: Date) => void;
  showDatePicker?: boolean;
}

const roleColors: Record<UserRole, string> = {
  employee: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  manager: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  hr: 'bg-green-500/20 text-green-400 border-green-500/30',
  admin: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
};

const roleLabels: Record<UserRole, string> = {
  employee: 'Employee',
  manager: 'Manager',
  hr: 'HR',
  admin: 'Admin',
};

export default function AppHeader({ 
  user, 
  onLogout, 
  onMenuClick,
  onToggleSidebar,
  selectedDate = new Date(),
  onDateChange,
  showDatePicker = false
}: AppHeaderProps) {
  const formatDate = (date: Date) => {
    return date.toLocaleDateString('en-IN', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'Asia/Kolkata'
    });
  };

  const handleMenuClick = () => {
    if (onToggleSidebar) {
      onToggleSidebar();
    } else if (onMenuClick) {
      onMenuClick();
    }
  };

  return (
    <header className="h-16 bg-slate-900/80 backdrop-blur-xl border-b border-blue-500/20 px-4 md:px-6 flex items-center justify-between gap-4" data-testid="app-header">
      <div className="flex items-center gap-4">
        <Button 
          size="icon" 
          variant="ghost" 
          onClick={handleMenuClick}
          className="text-blue-400"
          data-testid="button-menu"
        >
          <Menu className="w-5 h-5" />
        </Button>
        
        <img 
          src={logoImage} 
          alt="Time Strap" 
          className="h-8 md:h-10 object-contain"
          data-testid="header-logo"
        />
      </div>

      {showDatePicker && (
        <div className="hidden md:flex items-center gap-2 px-4 py-2 bg-slate-800/50 rounded-lg border border-blue-500/20">
          <Calendar className="w-4 h-4 text-blue-400" />
          <span className="text-sm text-blue-100" data-testid="text-selected-date">
            {formatDate(selectedDate)}
          </span>
        </div>
      )}

      <div className="flex items-center gap-4">
        <div className="hidden sm:flex flex-col items-end">
          <span className="text-sm font-medium text-white" data-testid="text-user-name">
            {user.name}
          </span>
          <span className="text-xs text-blue-300/60" data-testid="text-user-code">
            {user.employeeCode}
          </span>
        </div>
        
        <Badge 
          variant="outline" 
          className={`${roleColors[user.role]} text-xs`}
          data-testid="badge-user-role"
        >
          {roleLabels[user.role]}
        </Badge>

        <AlertsPopover employeeId={user.id} />
        
        <Button 
          size="icon" 
          variant="ghost" 
          onClick={onLogout}
          className="text-red-400 hover:text-red-300 hover:bg-red-500/10"
          data-testid="button-logout"
        >
          <LogOut className="w-5 h-5" />
        </Button>
      </div>
    </header>
  );
}

import { registerGlobalErrorToasts, initAppModal } from './js/core/ui.js';
import { initNavigation } from './js/features/navigation.js';
import { loadWorkout, loadWeek } from './js/features/workout.js';
import { loadTemplate } from './js/features/template.js';
import { loadBodyTab } from './js/features/progress/index.js';

registerGlobalErrorToasts();
initAppModal();

initNavigation({
  loadTemplate,
  loadBodyTab,
  loadWeek,
  loadWorkout,
});

loadWeek();

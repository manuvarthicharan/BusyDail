import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';

const SUPABASE_URL = 'https://atauxjrnhbobpelsiggj.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF0YXV4anJuaGJvYnBlbHNpZ2dqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUyOTUwNjAsImV4cCI6MjA5MDg3MTA2MH0.NYOGLhEstBOosCK7x2AqsndUID6keLI2_AX6p61hqYY';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Get current logged in user
export const getUser = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    return user;
};

// Get business record for current user
export const getBusiness = async (email) => {
    const { data } = await supabase
        .from('businesses')
        .select('*')
        .eq('email', email)
        .single();
    return data;
};

// Redirect to login if not logged in
export const requireAuth = async () => {
    const user = await getUser();
    if (!user) {
        window.location.href = '/login.html';
        return null;
    }
    return user;
};
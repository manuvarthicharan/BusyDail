import { supabase, getUser, getBusiness } from './supabase.js';

export async function requireAuthAndBusiness() {
    const user = await getUser();

    if (!user) {
        window.location.href = 'login.html';
        return { user: null, business: null };
    }

    let business = await getBusiness(user.email);

    // Auto-create business for Google Auth new users
    if (!business) {
        const displayName = user.user_metadata?.full_name
            || user.user_metadata?.name
            || user.email.split('@')[0];

        const { data: newBusiness, error } = await supabase
            .from('businesses')
            .insert({
                name: displayName,
                email: user.email,
                plan: 'free',
                calls_used_this_month: 0
            })
            .select()
            .single();

        if (error) {
            // Maybe duplicate — try fetching again
            const { data: existingBusiness } = await supabase
                .from('businesses')
                .select('*')
                .eq('email', user.email)
                .single();
            business = existingBusiness;
        } else {
            business = newBusiness;
        }
    }

    if (!business) {
        window.location.href = 'login.html';
        return { user: null, business: null };
    }

    return { user, business };
}

export { supabase };
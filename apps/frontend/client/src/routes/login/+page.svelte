<script lang="ts">
import { AuthView } from '#lib/views/auth';
import { getAuthViewModel } from '#lib/views/auth/auth_composition';
import { sessionState } from '#lib/services/session_service.svelte';
import { goto } from '$app/navigation';
import { onMount } from 'svelte';

const viewModel = getAuthViewModel();

onMount(() => {
  if (sessionState.isAuthenticated) {
    void goto('/');
  }
});
</script>

<AuthView {viewModel} />

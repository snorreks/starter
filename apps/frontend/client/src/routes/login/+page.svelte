<script lang="ts">
import { onMount } from 'svelte';
import { sessionState } from '#lib/services/session_service.svelte';
import { AuthView } from '#lib/views/auth';
import { getAuthViewModel } from '#lib/views/auth/auth_composition';
import { goto } from '$app/navigation';

const viewModel = getAuthViewModel();

onMount(() => {
  if (sessionState.isAuthenticated) {
    void goto('/');
  }
});
</script>

<AuthView {viewModel} />

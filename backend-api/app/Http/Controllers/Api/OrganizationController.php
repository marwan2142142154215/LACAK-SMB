<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\StoreOrganizationRequest;
use App\Http\Requests\UpdateOrganizationRequest;
use App\Http\Resources\OrganizationResource;
use App\Http\Responses\ApiResponse;
use App\Models\Organization;
use Illuminate\Http\Request;

class OrganizationController extends Controller
{
    use ApiResponse;

    public function index(Request $request)
    {
        $request->user()->can('organizations.manage') || abort(403);

        $organizations = Organization::query()
            ->withCount('devices')
            ->when($request->boolean('only_active'), fn ($q) => $q->where('is_active', true))
            ->orderBy('name')
            ->paginate($request->integer('per_page', 15));

        return $this->success('Daftar site/organization', [
            'items' => OrganizationResource::collection($organizations),
            'total' => $organizations->total(),
            'last_page' => $organizations->lastPage(),
        ]);
    }

    public function store(StoreOrganizationRequest $request)
    {
        $organization = Organization::create([
            'name' => $request->validated('name'),
            'type' => $request->validated('type'),
            'unique_site_code' => $request->generatedSiteCode(),
            'is_active' => true,
            'created_by' => $request->user()->id,
            'updated_by' => $request->user()->id,
        ]);

        return $this->success('Site berhasil dibuat', new OrganizationResource($organization), 201);
    }

    public function show(Request $request, Organization $organization)
    {
        $request->user()->can('organizations.manage') || abort(403);

        return $this->success('Detail site', new OrganizationResource($organization->loadCount('devices')));
    }

    public function update(UpdateOrganizationRequest $request, Organization $organization)
    {
        $organization->update([
            ...$request->validated(),
            'updated_by' => $request->user()->id,
        ]);

        return $this->success('Site berhasil diperbarui', new OrganizationResource($organization));
    }

    public function destroy(Request $request, Organization $organization)
    {
        $request->user()->can('organizations.manage') || abort(403);

        $organization->delete();

        return $this->success('Site berhasil dihapus (soft delete)');
    }
}

// This model is versioned by the service. Runtime checks always pin its ID.
const direct = () => ({
  this: {},
});
export const authorizationModel = {
  schema_version: "1.1",
  type_definitions: [
    { type: "user" },
    {
      type: "workspace",
      relations: { member: direct() },
      metadata: { relations: { member: { directly_related_user_types: [{ type: "user" }] } } },
    },
    {
      type: "meeting",
      relations: {
        owner: direct(),
        viewer: direct(),
        workspace: direct(),
        can_view: {
          intersection: {
            child: [
              {
                union: {
                  child: [
                    { computedUserset: { relation: "owner" } },
                    { computedUserset: { relation: "viewer" } },
                  ],
                },
              },
              {
                tupleToUserset: {
                  tupleset: { relation: "workspace" },
                  computedUserset: { relation: "member" },
                },
              },
            ],
          },
        },
        can_manage: {
          intersection: {
            child: [
              { computedUserset: { relation: "owner" } },
              {
                tupleToUserset: {
                  tupleset: { relation: "workspace" },
                  computedUserset: { relation: "member" },
                },
              },
            ],
          },
        },
      },
      metadata: {
        relations: {
          owner: { directly_related_user_types: [{ type: "user" }] },
          viewer: { directly_related_user_types: [{ type: "user" }] },
          workspace: { directly_related_user_types: [{ type: "workspace" }] },
        },
      },
    },
  ],
};
